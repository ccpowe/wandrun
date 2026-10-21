"""Authenticated page viewing and human input for a browser lease.

Protocol v1: each binary message is uint32 big-endian JSON-header length, the
UTF-8 JSON header, then JPEG bytes. Header: t=frame, seq, connection_id,
page, epoch, vp, css, dpr, scroll, pageScale, offsetTop, dropped_frames,
ack_wait_ms, applied_input_id, quality_tier and quality_reason; also
max_in_flight, in_flight (including this frame), frame_age_ms (Chrome swap
to send), credit_wait_ms (continuous pending-slot wait for credit),
send_lock_ms (previous send_bytes duration), ack_baseline_ms, ack_smoothed_ms
and queue_delay_ms. in_flight_bytes reserves JPEG bytes plus 2048 bytes per
wire header, including invalidated generations until ACK; byte_budget is the
current reservation ceiling, delivery_rate_bps is estimated bytes/second,
and stop_reason is the last pause before this frame:
none/frame-credit/byte-credit/pacing/oldest-frame. ACK turnaround is not
network RTT. Unavailable timings are null; durations are nonnegative ms.
Chrome/gateway wall clocks must agree for frame age; all intervals use a
monotonic clock. The input marker denotes dispatch before swap, not proof of
visual effect. JSON messages carry hello/pages (including max_pages),
input_pending, input_done, page_done, reject {id, why}, and ping/pong {id}.
input_done includes input_lock_wait_ms (receive to view lock), input_cdp_ms
(view lock to CDP completion), input_dispatch_ms (receive to CDP completion).
hello advertises connection_id, ping_supported, fps_limit (default 24;
?fps=12..30), window_mode (adaptive or fixed), max_in_flight (initial window),
and max_in_flight_limit (32). Omitted ?max_in_flight selects adaptive 2..32;
?max_in_flight=1..32 fixes the frame window and disables learned pacing/BDP and
oldest-frame gates for comparisons; the 1 MiB hard byte ceiling still applies.
Frames start no more
often than the chosen rate; only the newest pending frame is retained when
credits are exhausted. Clients ACK each received seq exactly once with
{t:"ack",seq,displayed:boolean}; an ACK returns its credit even when display
was skipped. A skipped ACK revokes that seq as an input credential; previously
sent frames retain bounded input history. Missing ACKs stop delivery at the
window limit. new_page {id, epoch} creates an about:blank page only under
human control and below the lease page limit, including when all pages have
been closed; page_done includes its target, epoch and vp.

Each connection lowers its native Chrome encoder only with sustained rising
turnaround plus a rate deficit, or a severe, sustained qualified delivery deficit.
Stable jitter, high turnaround and a large JPEG alone do not lower quality.
Higher-tier trials use delivery saturation without treating the jitter floor
as congestion. The window retains BDP credits, bounded rate max filter, pacing
and an oldest-frame guard. A 10s rolling minimum detects drift; it cannot raise
the baseline. Only a drift-triggered two-credit probe, drained and sampled for
a baseline turnaround, can raise it. Cuts never manufacture credits.
Encoding changes preserve CSS coordinates and vp; document, viewport and
control changes still invalidate input. After visually distinct frames stop,
a reduced-tier connection sends one sharp screenshot through the same window.
Identical source frames are ignored so screenshot-induced repaint events cannot
cancel that refresh or overwrite it with a blurry duplicate. A sharp refresh
is not an ACK training sample and does not claim input-latency attribution.
ACK timing cannot independently distinguish transport queue from receiver or
network scheduling jitter; queue/rate signals are not a capacity measurement.

Inputs carry id, epoch, vp and frame (the displayed seq). Coordinates are remote
CSS pixels, never device pixels. A view-mode socket cannot mutate pages even
while another socket controls the lease. Switching the viewed page is local to
this socket; it never steals another viewer's page. Mouse down/up and touch
start/end/cancel are assembled locally: start (and intermediate moves) replies
input_pending without sending to Chrome, so there is no live drag feedback.
A repeated start replaces the unfinished gesture; at most 256 commands may be
assembled. The starting frame is retained for that gesture even after the
32-frame input history evicts it. A gesture is validated once before sending;
known document/viewport/control changes reject the whole group. Concurrent
navigation is best-effort and never splits an accepted down/up pair.
"""

import asyncio
import base64
from collections import Counter, OrderedDict, deque
import json
import logging
import math
import struct
import time
from urllib.parse import urlsplit
from uuid import uuid4

from starlette.responses import JSONResponse
from starlette.websockets import WebSocket, WebSocketDisconnect


MAX_TEXT = 4096
INPUT_MARKER_HISTORY = 256
DEFAULT_FPS = 24
IDLE_REFRESH_SECONDS = .45
QUALITY_CONFIRM_DOWN = 2
QUALITY_CONFIRM_UP = 6
BUTTONS = {"left": 1, "right": 2, "middle": 4}
MAX_IN_FLIGHT = 32
BASELINE_SECONDS = 10
# Limits already-accepted JPEG plus header reservation; not compressed TCP bytes.
MAX_IN_FLIGHT_BYTES = 1024 * 1024
FRAME_OVERHEAD = 2048  # Conservative reservation, checked against the wire header.
logger = logging.getLogger(__name__)


class StreamRejected(ValueError):
    """A client request was not applied; the message is a protocol rejection code."""


def _number(message, key, default=None):
    value = message.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise StreamRejected(f"invalid-{key}")
    return value


def _integer(message, key, minimum, maximum, default=None):
    value = _number(message, key, default)
    if int(value) != value or not minimum <= value <= maximum:
        raise StreamRejected(f"invalid-{key}")
    return int(value)

class _FrameWindow:
    """ACK-owned frame/byte credits and bounded busy-pair delivery estimates.

    B is an application delivery rate in reserved bytes/s, not path capacity.
    Initial demand comes from the first real source JPEG, not a guessed size.
    """

    _GAINS = (1.25, .75, 1., 1., 1., 1., 1., 1.)
    _TIERS = ("high", "medium", "low")

    def __init__(self, fps, fixed):
        self.fps = fps
        self.fixed = fixed
        self.limit = fixed if fixed is not None else 2
        self.baseline_ms = None
        self.smoothed_ms = None
        self.queue_ms = None
        self._minimum = deque()
        self._rates = deque()
        self._turnarounds = deque(maxlen=256)
        self._next_probe = 0.0
        self._probe_started = None
        self._probe_drained = None
        self._probe_minimum = None
        self.delivery_rate = None
        self._last_delivery = None
        self._last_size = 1
        self._tier_sizes = {}
        self._current_tier = "high"
        self._next_growth = 0.0
        self._cycle_started = None
        self._phase = 0
        self._sample_counts = Counter()
        self._adjustments = deque(maxlen=256)
        self._adjustment_count = 0
        self._last_logged_rate = None
        self._rate_reason = "initial-demand"
        self._pair_gaps = None
        self._last_qualified_at = None
        self._last_sample_at = None
        self._higher_trial_at = 0.0
        self._deficit_since = None
        self._deficit_last_at = None

    def observe(self, tier, jpeg_size):
        """Remember real source size, including before the first delivered ACK."""
        charged = jpeg_size + FRAME_OVERHEAD
        self._tier_sizes[tier] = charged
        if tier == self._current_tier:
            self._last_size = charged
            if self.delivery_rate is None:
                self.delivery_rate = float(self.fps * charged)
                self._rate_reason = "initial-demand"
            elif self.delivery_rate > self.fps * charged:
                self.delivery_rate = float(self.fps * charged)
                self._rate_reason = "demand-cap"

    def sample(self, now, turnaround_ms, *, outstanding=None, started=None):
        """Raise the propagation baseline only after an explicitly drained probe.

        The rolling minimum is a drift detector, never permission to absorb a
        persistent queue into BDP. Probe ACKs must have been sent after draining.
        """
        self._last_sample_at = now
        while self._minimum and self._minimum[0][0] <= now - BASELINE_SECONDS:
            self._minimum.popleft()
        while self._minimum and self._minimum[-1][1] >= turnaround_ms:
            self._minimum.pop()
        self._minimum.append((now, turnaround_ms))
        if self.baseline_ms is None:
            self.baseline_ms = turnaround_ms
            self._next_probe = now + BASELINE_SECONDS
        else:
            self.baseline_ms = min(self.baseline_ms, turnaround_ms)
        self.smoothed_ms = (turnaround_ms if self.smoothed_ms is None else
                            .75 * self.smoothed_ms + .25 * turnaround_ms)
        self.queue_ms = max(0, self.smoothed_ms - self.baseline_ms)
        self._turnarounds.append((now, turnaround_ms))
        # Keep one predecessor at the window boundary, including sparse ACKs.
        while len(self._turnarounds) > 2 and self._turnarounds[1][0] < now - 4:
            self._turnarounds.popleft()
        if self.fixed is not None:
            return
        if self._probe_started is not None:
            if outstanding is not None and outstanding <= 1:
                if self._probe_drained is None:
                    self._probe_drained = now
                elif started is not None and started >= self._probe_drained:
                    self._probe_minimum = (turnaround_ms if self._probe_minimum is None
                                           else min(self._probe_minimum, turnaround_ms))
                    if now - self._probe_drained >= self.baseline_ms / 1000:
                        self.baseline_ms = self._probe_minimum
                        self.queue_ms = max(0, self.smoothed_ms - self.baseline_ms)
                        self._minimum.clear()
                        self._minimum.append((now, self.baseline_ms))
                        self._probe_started = self._probe_drained = self._probe_minimum = None
                        self._next_probe = now + BASELINE_SECONDS
            return
        if now >= self._next_probe:
            self._next_probe = now + BASELINE_SECONDS
            if self._minimum[0][1] > 1.2 * self.baseline_ms and self.queue_ms > 150:
                self._probe_started = now

    def _queue_growing(self):
        """Elapsed-time trend, not an ACK-count threshold or jitter floor."""
        points = self._turnarounds
        if len(points) < 3 or points[-1][0] - points[0][0] < 3:
            return False
        origin = points[0][0]
        mean_t = sum(t - origin for t, _ in points) / len(points)
        mean_y = sum(y for _, y in points) / len(points)
        variance = sum((t - origin - mean_t) ** 2 for t, _ in points)
        slope = sum((t - origin - mean_t) * (y - mean_y) for t, y in points) / variance
        return slope > 100 and slope * (points[-1][0] - origin) > 300

    def delivered(self, now, started, jpeg_size, tier):
        if self._cycle_started is None:
            # The first ACK completes the first send's phase, rather than
            # starting another full RTT of probing at ACK arrival.
            self._cycle_started = started
        charged = jpeg_size + FRAME_OVERHEAD
        self._pair_gaps = None
        self.observe(tier, jpeg_size)
        previous = self._last_delivery
        if previous is not None and started <= previous[1]:
            self._sample_counts["non-increasing-send"] += 1
            return
        self._last_delivery = (now, started, tier)
        if previous is None or previous[2] != tier:
            self._sample_counts["no-same-tier-pair"] += 1
        else:
            ack_gap, send_gap = now - previous[0], started - previous[1]
            self._pair_gaps = (send_gap * 1000, ack_gap * 1000)
            if ack_gap <= 0 or send_gap <= 0:
                self._sample_counts["nonpositive-gap"] += 1
            elif send_gap > max(2 / self.fps, 1.25 * self.interval(charged)):
                self._sample_counts["not-busy"] += 1
            else:
                rate = min(self.fps * self._last_size,
                           charged / max(send_gap, ack_gap))
                while self._rates and self._rates[-1][1] <= rate:
                    self._rates.pop()
                self._rates.append((now, rate))
                self._last_qualified_at = now
                self._sample_counts["qualified"] += 1
        self._expire_rates(now)

    def _expire_rates(self, now):
        horizon = max(.5, 10 * (self.baseline_ms or 0) / 1000)
        expired = False
        while self._rates and self._rates[0][0] <= now - horizon:
            self._rates.popleft()
            expired = True
        if self._rates:
            rate = min(self.fps * self._last_size, self._rates[0][1])
            if rate != self.delivery_rate:
                self._rate_reason = "max-filter-expiry" if expired else "max-filter-update"
                self.delivery_rate = rate

    def quality_changed(self, now, tier):
        """Reset the adjacent pair, not ownership of older encoder deliveries."""
        self._last_delivery = None
        self._last_qualified_at = None
        self._deficit_since = None
        self._deficit_last_at = None
        self._rates.clear()
        self._current_tier = tier
        if tier in self._tier_sizes:
            self._last_size = self._tier_sizes[tier]
            if self.delivery_rate is not None and self.delivery_rate > self.fps * self._last_size:
                self.delivery_rate = float(self.fps * self._last_size)
                self._rate_reason = "tier-demand-cap"
        self._higher_trial_at = now + max(.5, (self.baseline_ms or 0) / 1000)

    def byte_budget(self, charged_size):
        if self.fixed is not None or self.baseline_ms is None or self.delivery_rate is None:
            return MAX_IN_FLIGHT_BYTES
        return min(MAX_IN_FLIGHT_BYTES, max(charged_size, math.ceil(
            1.25 * (self.delivery_rate * self.baseline_ms / 1000 + charged_size))))

    def interval(self, charged_size):
        if self.fixed is not None or self.delivery_rate is None:
            return 1 / self.fps
        return max(1 / self.fps, charged_size / (self.delivery_rate * self._GAINS[self._phase]))

    def blocked(self, now, outstanding, charged_size, *, in_flight_bytes=None):
        if len(outstanding) >= self.limit:
            return "frame-credit"
        if in_flight_bytes is None:
            in_flight_bytes = sum(item[1] + FRAME_OVERHEAD for item in outstanding.values())
        if in_flight_bytes + charged_size > self.byte_budget(charged_size):
            return "byte-credit"
        if (self.fixed is None and outstanding and self.baseline_ms is not None
                and now - min(item[0] for item in outstanding.values()) >
                self.baseline_ms / 1000 + .8):
            return "oldest-frame"
        return "none"

    def quality(self, tier, jpeg_size):
        """Use growth or a sustained severe deficit, never isolated ACK gaps.

        Stable jitter has a nonzero queue floor, so recovery tests the trend.
        Three sparse ACKs spanning three seconds can establish growth. Once a
        narrow path settles, six seconds of fresh busy-pair estimates below an
        eighth of demand still support a deficit without requiring a rising queue.
        """
        self.observe(tier, jpeg_size)
        queue = self.queue_ms or 0
        position = self._TIERS.index(tier)
        growing = self._queue_growing()
        demand = self.fps * self._last_size
        now = self._last_sample_at
        fresh_for = max(2, 2 * (self.baseline_ms or 0) / 1000)
        fresh = (now is not None and self._last_qualified_at is not None
                 and now - self._last_qualified_at <= fresh_for)
        if fresh and self._rates and self.delivery_rate is not None and self.delivery_rate < .125 * demand:
            if self._deficit_since is None or now - self._deficit_last_at > fresh_for:
                self._deficit_since = now
            self._deficit_last_at = now
        else:
            self._deficit_since = None
        sustained_deficit = self._deficit_since is not None and now - self._deficit_since >= 6
        if (position < 2 and (sustained_deficit or (
                growing and queue > 150 and self.delivery_rate is not None
                and self.delivery_rate < .8 * demand))):
            return self._TIERS[position + 1], "bandwidth"
        if (position > 0 and not growing and self._rates
                and self.delivery_rate is not None
                and self.delivery_rate >= .95 * demand
                and self._last_qualified_at is not None
                and self._last_qualified_at >= self._higher_trial_at
                and self._last_sample_at - self._last_qualified_at <= max(
                    .5, (self.baseline_ms or 0) / 1000)):
            return self._TIERS[position - 1], "recovered"
        return tier, "steady"

    def adjust(self, now):
        if self.fixed is not None or self.baseline_ms is None or self.delivery_rate is None:
            return
        old_limit, old_rate = self.limit, self._last_logged_rate
        self._expire_rates(now)
        baseline = self.baseline_ms / 1000
        period = max(.5, baseline)
        if self._cycle_started is None:
            self._cycle_started = now
        if now - self._cycle_started >= period:
            self._phase = (self._phase + 1) % len(self._GAINS)
            self._cycle_started = now
        target = (2 if self._probe_started is not None else
                  min(MAX_IN_FLIGHT, max(2, math.ceil(
                      1.25 * self.delivery_rate * baseline / self._last_size) + 1)))
        if self.limit > target:
            self.limit = target
            window_reason = "bdp-decrease"
        elif now >= self._next_growth:
            self.limit = min(target, self.limit + 1)
            self._next_growth = now + period
            window_reason = "bdp-growth" if self.limit != old_limit else None
        else:
            window_reason = None
        if old_limit != self.limit or old_rate != self.delivery_rate:
            rate_reason = self._rate_reason if old_rate != self.delivery_rate else None
            self._adjustment_count += 1
            # INFO keeps aggregates and window transitions; DEBUG opts into
            # full estimator evidence without adding another runtime setting.
            if window_reason is not None or logger.isEnabledFor(logging.DEBUG):
                self._adjustments.append({
                    "at_monotonic": now,
                    "reason": (f"{rate_reason}+{window_reason}" if rate_reason and window_reason
                               else rate_reason or window_reason),
                    "rate_reason": rate_reason, "window_reason": window_reason,
                    "old_rate_bps": old_rate, "new_rate_bps": self.delivery_rate,
                    "old_window": old_limit, "new_window": self.limit,
                    "send_gap_ms": self._pair_gaps[0] if self._pair_gaps else None,
                    "ack_gap_ms": self._pair_gaps[1] if self._pair_gaps else None})
        self._last_logged_rate = self.delivery_rate


_BROWSER_REJECTION_CODES = {
    "浏览器管理器已关闭": "browser-unavailable",
    "任务没有可用的浏览器": "browser-unavailable",
    "任务结束，浏览器排队已取消": "task-ended",
    "任务结束，浏览器分配已取消": "task-ended",
    "浏览器正在关闭或已结束，无法新建页面": "browser-ended",
    "浏览器页面数已达上限": "page-limit",
    "浏览器未处于当前接管代际": "stale-epoch",
    "旧控制代际或浏览器不在接管中": "stale-epoch",
    "页面不属于本租约": "no-such-page",
    "页面不属于活动浏览器租约": "no-such-page",
    "浏览器控制权已转交，旧代际不能关闭页面": "stale-epoch",
    "页面不可关闭或不属于本租约": "no-such-page",
    "人的输入方法不允许": "invalid-input",
}


def _safe_rejection(error):
    """Keep CDP diagnostics on the server, not in the display protocol."""
    reason = str(error)
    if isinstance(error, StreamRejected):
        return reason
    return _BROWSER_REJECTION_CODES.get(reason, "browser-operation-failed")


class BrowserStream:
    """One viewer: a latest-frame slot, bounded sent-frame history and input guard.

    Lease ownership and control barriers stay in BrowserLeases. This class owns
    only socket-specific view selection, viewport generations and wire encoding.
    Unacknowledged frames occupy credits until ACK or view invalidation.
    """

    def __init__(self, websocket, browser, lease_id, *, control=False, max_in_flight=None, fps=DEFAULT_FPS):
        if max_in_flight is not None and (type(max_in_flight) is not int or not 1 <= max_in_flight <= MAX_IN_FLIGHT):
            raise ValueError(f"max_in_flight must be an integer from 1 to {MAX_IN_FLIGHT}")
        if type(fps) is not int or not 12 <= fps <= 30:
            raise ValueError("fps must be an integer from 12 to 30")
        self.fps = fps
        self.window = _FrameWindow(fps, max_in_flight)
        self.ws, self.browser, self.lease_id = websocket, browser, lease_id
        self.connection_id = uuid4().hex
        self._interval_wall_start = time.time()
        self._interval_mono_start = time.perf_counter()
        self._adjustment_batches = 0
        self._interval_first_seq = None
        self._interval_last_seq = None
        self._interval_ack_first_seq = None
        self._interval_ack_last_seq = None
        self._acked_jpeg_bytes = 0
        self._acked_reserved_bytes = 0
        self._acked_packet_bytes = 0
        self._acked_frames = 0
        self._acked_retired_frames = 0
        self._packet_sizes = {}
        self._ack_turnarounds = deque(maxlen=4096)
        self._ack_turnaround_count = 0
        self._pause_reason = None
        self._pause_started = None
        self._pause_ms = {}
        self.control = control
        self.page = None
        self.history = []
        self.vp = 0
        self.css = (0, 0)
        self.dpr = 1.0
        self.seq = 0
        self.sent = OrderedDict()
        self.pending = None
        self.dropped_frames = 0
        self.ack_wait_ms = None
        self.outstanding = {}
        self._retired_bytes = {}
        self._last_send_started = None
        self.quality_tier = "high"
        self.quality_reason = "initial"
        self._quality_candidate = None
        self._quality_samples = 0
        self._last_displayed_seq = 0
        self._last_offer_at = None
        self._idle_task = None
        self._last_visual = None
        self._last_metadata = None
        self._applied_dispatches = []
        self.frame_wake = asyncio.Event()
        self.state_wake = asyncio.Event()
        self._signature = None
        self._pages = None
        self._stop_frames = None
        self._send_lock = asyncio.Lock()
        self._view_lock = asyncio.Lock()
        self._tasks = []
        self._gesture = None
        self._closed = False
        self._credit_wait_started = None
        self._credit_wait_ms = 0.0
        self.send_lock_ms = None
        self._segments = {}
        self.stop_reason = "none"
        self._peaks = {}
        self._stops = {}

    @property
    def in_flight_bytes(self):
        return (sum(item[1] + FRAME_OVERHEAD for item in self.outstanding.values())
                + sum(self._retired_bytes.values()))

    def _diagnostics(self):
        now = time.perf_counter()
        values = {"in_flight": len(self.outstanding), "in_flight_bytes": self.in_flight_bytes,
                  "retired_bytes": sum(self._retired_bytes.values()),
                  "oldest_age_ms": max(max(0, now - item[0]) * 1000 for item in self.outstanding.values())
                                   if self.outstanding else 0,
                  "max_in_flight": self.max_in_flight, "queue_delay_ms": self.window.queue_ms,
                  "delivery_rate_bps": self.window.delivery_rate}
        for name, value in values.items():
            if value is not None:
                self._peaks[name] = max(self._peaks.get(name, 0), value)

    def _end_credit_wait(self, now):
        if self._credit_wait_started is not None:
            self._credit_wait_ms += max(0, now - self._credit_wait_started) * 1000
            self._credit_wait_started = None

    def _pause(self, reason, now):
        if reason == self._pause_reason:
            return
        if self._pause_reason is not None:
            previous = self._pause_reason
            self._pause_ms[previous] = self._pause_ms.get(previous, 0) + max(
                0, now - self._pause_started) * 1000
        self._pause_reason = reason
        self._pause_started = now if reason is not None else None
        if reason is not None:
            self.stop_reason = reason
            self._stops[reason] = self._stops.get(reason, 0) + 1

    def _blocked(self, now, size):
        reason = self.window.blocked(now, self.outstanding, size, in_flight_bytes=self.in_flight_bytes)
        self._pause(None if reason == "none" else reason, now)
        if reason != "none":
            if self._credit_wait_started is None:
                self._credit_wait_started = now
            self.frame_wake.clear()
        return reason != "none"

    @property
    def max_in_flight(self):
        return self.window.limit

    def _measure(self, name, milliseconds):
        if milliseconds is not None:
            count, total, peak = self._segments.get(name, (0, 0.0, 0.0))
            self._segments[name] = (count + 1, total + milliseconds, max(peak, milliseconds))

    def _record_ack(self, seq, jpeg_size, turnaround_ms=None):
        self._interval_ack_first_seq = (seq if self._interval_ack_first_seq is None
                                        else min(seq, self._interval_ack_first_seq))
        self._interval_ack_last_seq = (seq if self._interval_ack_last_seq is None
                                       else max(seq, self._interval_ack_last_seq))
        self._acked_frames += 1
        self._acked_jpeg_bytes += jpeg_size
        self._acked_reserved_bytes += jpeg_size + FRAME_OVERHEAD
        self._acked_packet_bytes += self._packet_sizes.pop(seq, 0)
        if turnaround_ms is not None:
            self._ack_turnarounds.append(turnaround_ms)
            self._ack_turnaround_count += 1

    def _flush_adjustments_if_full(self):
        events = self.window._adjustments
        if len(events) < events.maxlen:
            return
        # The five-second stats task can be delayed; never silently overwrite
        # individual adjustment evidence when an interval exceeds the bound.
        logger.info("[stream-adjustments] %s", json.dumps({
            "connection_id": self.connection_id,
            "wall_at_s": time.time(), "monotonic_at_s": time.perf_counter(),
            "interval_monotonic_start_s": self._interval_mono_start,
            "adjustments": list(events),
        }, separators=(",", ":")))
        self._adjustment_batches += 1
        events.clear()

    def _log_stats(self, *, final=False):
        end_mono, end_wall = time.perf_counter(), time.time()
        active_pause = self._pause_reason
        self._diagnostics()
        self._pause(None, end_mono)
        turnarounds = sorted(self._ack_turnarounds)
        def percentile(fraction):
            if not turnarounds:
                return None
            return turnarounds[max(0, math.ceil(fraction * len(turnarounds)) - 1)]
        elapsed = max(0, end_mono - self._interval_mono_start)
        # Preserve an ongoing pause across periodic flush boundaries.
        logger.info("[stream-stats] %s", json.dumps({
            "connection": self.connection_id, "connection_id": self.connection_id,
            "lease": self.lease_id, "final": final,
            "wall_start_s": self._interval_wall_start, "wall_end_s": end_wall,
            "monotonic_start_s": self._interval_mono_start, "monotonic_end_s": end_mono,
            "elapsed_s": elapsed, "seq_first": self._interval_first_seq,
            "seq_last": self._interval_last_seq,
            "ack_seq_first": self._interval_ack_first_seq,
            "ack_seq_last": self._interval_ack_last_seq,
            "acked_frames": self._acked_frames, "acked_retired_frames": self._acked_retired_frames,
            "acked_jpeg_bytes": self._acked_jpeg_bytes,
            "acked_reserved_bytes": self._acked_reserved_bytes,
            "acked_packet_bytes_pre_compression": self._acked_packet_bytes,
            "acked_reserved_Bps": self._acked_reserved_bytes / elapsed if elapsed else None,
            "window_mode": "adaptive" if self.window.fixed is None else "fixed",
            "max_in_flight": self.max_in_flight, "in_flight": len(self.outstanding),
            "in_flight_bytes": self.in_flight_bytes,
            "retired_bytes": sum(self._retired_bytes.values()),
            "byte_budget": self.window.byte_budget(self.window._last_size),
            "delivery_rate_bps": self.window.delivery_rate, "stop_reason": self.stop_reason,
            "interval_max": self._peaks, "stop_counts": self._stops,
            "pause_ms_by_reason": self._pause_ms,
            "sample_eligibility": self.window._sample_counts,
            "adjustment_count": self.window._adjustment_count,
            "adjustments": list(self.window._adjustments),
            "adjustment_batches": self._adjustment_batches,
            "ack_turnaround_ms": {"count": self._ack_turnaround_count,
                                   "retained": len(turnarounds), "p50": percentile(.5),
                                   "p90": percentile(.9),
                                   "max": turnarounds[-1] if turnarounds else None},
            "ack_baseline_ms": self.window.baseline_ms,
            "ack_smoothed_ms": self.window.smoothed_ms, "queue_delay_ms": self.window.queue_ms,
            "quality_tier": self.quality_tier, "dropped_frames": self.dropped_frames,
            "segments": {name: {"n": n, "mean_ms": total / n, "max_ms": peak}
                         for name, (n, total, peak) in self._segments.items()},
        }, separators=(",", ":")))
        self._interval_wall_start, self._interval_mono_start = end_wall, end_mono
        self._interval_first_seq = self._interval_last_seq = None
        self._interval_ack_first_seq = self._interval_ack_last_seq = None
        self._acked_frames = self._acked_jpeg_bytes = 0
        self._acked_retired_frames = 0
        self._acked_reserved_bytes = self._acked_packet_bytes = 0
        self._ack_turnarounds.clear()
        self._ack_turnaround_count = 0
        self.window._sample_counts.clear()
        self.window._adjustment_count = 0
        self._adjustment_batches = 0
        self.window._adjustments.clear()
        self._segments.clear()
        self._peaks.clear()
        self._stops.clear()
        self._pause_ms.clear()
        if not final and active_pause is not None:
            self._pause(active_pause, end_mono)

    async def _stats(self):
        while not self._closed:
            await asyncio.sleep(5)
            self._log_stats()

    async def send(self, message):
        async with self._send_lock:
            await self.ws.send_json(message)

    def _invalidate(self):
        self._pause(None, time.perf_counter())
        self.vp += 1
        self.pending = None
        self.sent.clear()
        # View credits expire, but reliable-stream bytes cannot be withdrawn.
        self._retired_bytes.update((seq, item[1] + FRAME_OVERHEAD)
                                   for seq, item in self.outstanding.items())
        self.outstanding.clear()
        self._diagnostics()
        self.window._last_delivery = None  # Never pair ACKs across view generations.
        self._credit_wait_started = None
        self._credit_wait_ms = 0.0
        self.frame_wake.clear()
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None
        self._last_offer_at = None
        self._last_visual = None
        self._last_metadata = None
        self._quality_candidate = None
        self._quality_samples = 0
        self._applied_dispatches.clear()

    def _changed(self, snapshot):
        # Invalidate synchronously: a queued input must not race the state pump.
        signature = self._view_signature(snapshot)
        if signature != self._signature:
            self._signature = signature
            self._invalidate()
        self.state_wake.set()

    def _view_signature(self, snapshot):
        page = next((p for p in snapshot["pages"] if p["id"] == self.page), None)
        return (snapshot["epoch"], self.page,
                None if page is None else (page.get("revision", 0), page.get("url")))

    async def run(self):
        unsubscribe = self.browser.subscribe(self.lease_id, self._changed)
        try:
            await self.send({"t": "hello", "protocol": 1, "mode": "control" if self.control else "view",
                             "connection_id": self.connection_id,
                             "binary": "uint32be-header-length+json+jpeg", "fps_limit": self.fps,
                             "max_in_flight": self.max_in_flight, "ping_supported": True,
                             "window_mode": "adaptive" if self.window.fixed is None else "fixed",
                             "max_in_flight_limit": MAX_IN_FLIGHT})
            async with self._view_lock:
                await self._sync_pages()
            if self._closed:
                return
            self._tasks = [asyncio.create_task(self._frames()), asyncio.create_task(self._states()),
                           asyncio.create_task(self._receive()), asyncio.create_task(self._stats())]
            done, _ = await asyncio.wait(self._tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (NameError, AttributeError, TypeError, AssertionError):
            # Outside a single input command the pipeline may be inconsistent.
            # Fail closed with an explicit protocol outcome, then reap all owners.
            logger.exception("Stream pipeline programming error")
            await self.ws.close(code=1011, reason="internal-error")
        finally:
            self._closed = True
            # Keep accounting alive until cancelled send_bytes has recorded its
            # finally sample; final flush also runs if source teardown fails.
            unsubscribe()
            # Revocation can arrive after a normal disconnect has begun cleanup.
            # Keep teardown owned here, even if that first cancellation arrives now.
            cleanup = asyncio.create_task(self._cleanup())
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
                raise
            finally:
                self._log_stats(final=True)
                self.outstanding.clear()
                self._retired_bytes.clear()
                self._packet_sizes.clear()
                self.sent.clear()

    async def _cleanup(self):
        if self._idle_task is not None:
            self._idle_task.cancel()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, *(x for x in (self._idle_task,) if x is not None),
                             return_exceptions=True)
        if self._stop_frames:
            await self._stop_frames()
            self._stop_frames = None
    async def _sync_pages(self, requested=None):
        snapshot = self.browser.detail(self.lease_id)
        signature = self._view_signature(snapshot)
        if signature != self._signature:
            self._signature = signature
            self._invalidate()
        if snapshot["state"] == "released":
            await self.send({"t": "ended", "reason": snapshot.get("reason"), "epoch": snapshot["epoch"]})
            # Publish closure before close() yields; the receiver must not begin
            # another receive after Starlette has already disconnected the socket.
            self._closed = True
            await self.ws.close(code=1000)
            return
        ids = {p["id"] for p in snapshot["pages"]}
        if snapshot["state"] in ("stopping", "revoking"):
            # The lease owns teardown/revocation. Keep its existing source; do
            # not attach a fallback page while targets are being removed.
            await self.send({"t": "pages", "current": self.page if self.page in ids else None,
                             "pages": snapshot["pages"], "max_pages": snapshot["max_pages"],
                             "epoch": snapshot["epoch"], "state": snapshot["state"],
                             "vp": self.vp, "css": list(self.css), "dpr": self.dpr})
            return
        if requested is not None and requested not in ids:
            raise StreamRejected("no-such-page")
        target = requested or self.page
        if target not in ids:
            target = next((p for p in reversed(self.history) if p in ids), snapshot.get("current"))
        if target != self.page:
            if self._stop_frames:
                await self._stop_frames()
                self._stop_frames = None
            self.page = target
            self._invalidate()
            self.css = (0, 0)
            if target:
                self.history = [p for p in self.history if p in ids and p != target] + [target]
                result = await self.browser.page_call(self.lease_id, target, "Runtime.evaluate", {
                    "expression": "[innerWidth,innerHeight,devicePixelRatio]", "returnByValue": True,
                })
                width, height, self.dpr = result["result"]["value"]
                self.css = (width, height)
                self._stop_frames = await self.browser.subscribe_frames(
                    self.lease_id, target, lambda params: self._offer(target, params),
                    **({"quality_tier": self.quality_tier} if self.quality_tier != "high" else {}),
                )
            self._signature = self._view_signature(snapshot)
        pages = {"t": "pages", "current": self.page, "pages": snapshot["pages"],
                 "max_pages": snapshot["max_pages"], "epoch": snapshot["epoch"],
                 "state": snapshot["state"], "vp": self.vp,
                 "css": list(self.css), "dpr": self.dpr}
        if pages != self._pages:
            self._pages = pages
            await self.send(pages)

    def _offer(self, target, params):
        if self._closed or target != self.page:
            return
        snapshot = self.browser.detail(self.lease_id)
        if snapshot["state"] == "released":
            return
        page = next((p for p in snapshot["pages"] if p["id"] == target), None)
        if page is None or params.get("_epoch", snapshot["epoch"]) != snapshot["epoch"]:
            return
        if params.get("_revision", page.get("revision", 0)) != page.get("revision", 0):
            return
        self._changed(snapshot)
        meta = params["metadata"]
        css = (round(meta["deviceWidth"]), round(meta["deviceHeight"]))
        dpr = meta.get("deviceScaleFactor", self.dpr)
        if css != self.css or dpr != self.dpr:
            self.css, self.dpr = css, dpr
            self._invalidate()
            self.state_wake.set()
        # captureScreenshot itself can emit a screencast frame. An identical
        # JPEG must neither cancel that capture nor replace its sharp result
        # with a low-tier duplicate. Keep the encoded string, without decoding
        # or hashing pixels; timestamps alone are not visual changes.
        visual = (params["data"], params.get("_quality_tier", "high"),
                  meta.get("scrollOffsetX", 0), meta.get("scrollOffsetY", 0),
                  meta.get("pageScaleFactor", 1), meta.get("offsetTop", 0))
        if visual == self._last_visual:
            return
        self._last_visual = visual
        if self.pending is not None:
            self.dropped_frames += 1
        self.pending = (params, snapshot["epoch"], self.vp, self._applied_id(meta))
        if params.get("_quality_reason") != "idle-refresh":
            data = params["data"]
            jpeg_size = len(data) // 4 * 3 - (len(data) - len(data.rstrip("=")))
            self.window.observe(params.get("_quality_tier", "high"), jpeg_size)
        self._last_metadata = meta
        self._last_offer_at = time.perf_counter()
        if self._idle_task is not None:
            self._idle_task.cancel()
        if self.quality_tier != "high":
            self._idle_task = asyncio.create_task(self._refresh_after_idle(target, self._last_offer_at))
        self.frame_wake.set()

    async def _switch_quality(self, tier, reason):
        """Replace only this socket's source; never relabel another viewer's JPEG."""
        self.window.quality_changed(time.perf_counter(), tier)
        async with self._view_lock:
            if self._closed or self.page is None:
                return
            self._quality_candidate, self._quality_samples = None, 0
            if self._idle_task is not None:
                self._idle_task.cancel()
                self._idle_task = None
            if self._stop_frames is not None:
                await self._stop_frames()
                self._stop_frames = None
            self.pending = None
            self.frame_wake.clear()
            self.quality_tier, self.quality_reason = tier, reason
            target = self.page
            self._stop_frames = await self.browser.subscribe_frames(
                self.lease_id, target, lambda params: self._offer(target, params),
                **({"quality_tier": tier} if tier != "high" else {}),
            )

    async def _refresh_after_idle(self, target, offered_at):
        """One sharp frame after motion stops; no polling or repeating screenshots."""
        try:
            await asyncio.sleep(IDLE_REFRESH_SECONDS)
            async with self._view_lock:
                if (self._closed or self.page != target or self._last_offer_at != offered_at
                        or self.quality_tier == "high" or self._last_metadata is None):
                    return
                snapshot = self.browser.detail(self.lease_id)
                epoch, signature = snapshot["epoch"], self._view_signature(snapshot)
                vp, css = self.vp, self.css
                metadata = self._last_metadata
            if not all(d > 0 for d in css):
                return
            dimensions = await self.browser.page_call(self.lease_id, target, "Runtime.evaluate", {
                "expression": "[innerWidth,innerHeight,devicePixelRatio]", "returnByValue": True,
            })
            if tuple(dimensions["result"]["value"]) != (*css, self.dpr):
                return
            scale = min(1, 1600 / css[0], 1000 / css[1])
            captured = await self.browser.page_call(self.lease_id, target, "Page.captureScreenshot", {
                "format": "jpeg", "quality": 75, "captureBeyondViewport": False,
                "clip": {"x": metadata.get("scrollOffsetX", 0),
                         "y": metadata.get("scrollOffsetY", 0),
                         "width": css[0], "height": css[1], "scale": scale},
            })
            async with self._view_lock:
                snapshot = self.browser.detail(self.lease_id)
                if (self._closed or self.page != target or self._last_offer_at != offered_at
                        or self.vp != vp or snapshot["epoch"] != epoch
                        or self._view_signature(snapshot) != signature):
                    return
                if self.pending is not None:
                    self.dropped_frames += 1
                self.pending = ({"metadata": metadata, "data": captured["data"],
                                 "_quality_tier": "high", "_quality_reason": "idle-refresh"},
                                epoch, vp, 0)
                self.frame_wake.set()
        except asyncio.CancelledError:
            raise
        except (LookupError, ValueError, RuntimeError, TimeoutError, ConnectionError):
            # A thumbnail is optional; the live stream and its input stay usable.
            return

    def _applied_id(self, metadata):
        # CDP timestamp is Unix wall seconds at frame swap, not event arrival
        # time. Ordering against the gateway's send boundary requires synchronized
        # Chrome/gateway clocks; absent timestamps yield no attribution.
        timestamp = metadata.get("timestamp")
        if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            return 0
        for input_id, dispatched_at in reversed(self._applied_dispatches):
            if timestamp > dispatched_at:
                return input_id
        return 0

    async def _states(self):
        while not self._closed:
            await self.state_wake.wait()
            self.state_wake.clear()
            async with self._view_lock:
                await self._sync_pages()

    def _pending_size(self):
        if self.pending is None:
            return self.window._last_size
        data = self.pending[0]["data"]
        return len(data) // 4 * 3 - (len(data) - len(data.rstrip("="))) + FRAME_OVERHEAD

    async def _frames(self):
        while not self._closed:
            await self.frame_wake.wait()
            if self.pending is None:
                self.frame_wake.clear()
                continue
            size = self._pending_size()
            now = time.perf_counter()
            if self._blocked(now, size):
                continue
            if self._last_send_started is not None:
                delay = self._last_send_started + self.window.interval(size) - now
                if delay > 0:
                    self._pause("pacing", now)
                    await asyncio.sleep(delay)
            async with self._view_lock:
                if self._closed:
                    return
                # Both locks can suspend. The final check and registration below
                # must have no await between them, including after a pong/ACK cut.
                async with self._send_lock:
                    size = self._pending_size()
                    now = time.perf_counter()
                    if self._blocked(now, size):
                        continue
                    if (self._last_send_started is not None and
                            self._last_send_started + self.window.interval(size) > now):
                        continue
                    pending, self.pending = self.pending, None
                    self.frame_wake.clear()
                    if pending is None:
                        continue
                    params, epoch, vp, applied_id = pending
                    if vp != self.vp or epoch != self.browser.detail(self.lease_id)["epoch"]:
                        continue
                    jpeg = base64.b64decode(params["data"])
                    self.seq += 1
                    meta = params["metadata"]
                    timestamp = meta.get("timestamp")
                    idle = params.get("_quality_reason") == "idle-refresh"
                    age = (max(0, (time.time() - timestamp) * 1000)
                           if not idle and type(timestamp) in (int, float) and math.isfinite(timestamp)
                           else None)
                    started = time.perf_counter()
                    self._end_credit_wait(started)
                    credit_wait, self._credit_wait_ms = self._credit_wait_ms, 0.0
                    header = {"t": "frame", "seq": self.seq, "connection_id": self.connection_id,
                              "page": self.page, "epoch": epoch,
                              "vp": vp, "css": list(self.css), "dpr": self.dpr,
                              "scroll": [meta.get("scrollOffsetX", 0), meta.get("scrollOffsetY", 0)],
                              "pageScale": meta.get("pageScaleFactor", 1), "offsetTop": meta.get("offsetTop", 0),
                              "dropped_frames": self.dropped_frames, "ack_wait_ms": self.ack_wait_ms,
                              "applied_input_id": applied_id,
                              "quality_tier": params.get("_quality_tier", "high"),
                              "quality_reason": params.get("_quality_reason", self.quality_reason),
                              "max_in_flight": self.max_in_flight, "in_flight": len(self.outstanding) + 1,
                              "in_flight_bytes": self.in_flight_bytes + size,
                              "byte_budget": self.window.byte_budget(size),
                              "delivery_rate_bps": self.window.delivery_rate,
                              "stop_reason": self.stop_reason,
                              "frame_age_ms": age, "credit_wait_ms": credit_wait,
                              "send_lock_ms": self.send_lock_ms,
                              "ack_baseline_ms": self.window.baseline_ms,
                              "ack_smoothed_ms": self.window.smoothed_ms,
                              "queue_delay_ms": self.window.queue_ms}
                    encoded = json.dumps(header, separators=(",", ":")).encode()
                    if len(encoded) + 4 > FRAME_OVERHEAD:
                        raise RuntimeError("frame header exceeds byte reservation")
                    packet = struct.pack("!I", len(encoded)) + encoded + jpeg
                    self.sent[self.seq] = (epoch, vp, self.page)
                    while len(self.sent) > 32:
                        self.sent.popitem(last=False)
                    self._last_send_started = started
                    self.outstanding[self.seq] = (started, len(jpeg), header["quality_reason"],
                                                   header["quality_tier"])
                    self._packet_sizes[self.seq] = len(packet)
                    if self._interval_first_seq is None:
                        self._interval_first_seq = self.seq
                    self._interval_last_seq = self.seq
                    self.stop_reason = "none"
                    self._diagnostics()
                    self._measure("frame_age_ms", age)
                    self._measure("credit_wait_ms", credit_wait)
                    sending = time.perf_counter()
                    try:
                        await self.ws.send_bytes(packet)
                    finally:
                        self.send_lock_ms = (time.perf_counter() - sending) * 1000
                        self._measure("send_lock_ms", self.send_lock_ms)

    async def _receive(self):
        while not self._closed:
            raw = await self.ws.receive_text()
            received_at = time.perf_counter()
            try:
                if len(raw) > 32_768:
                    raise StreamRejected("message-too-large")
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise StreamRejected("invalid-message")
            except (ValueError, TypeError) as error:
                logger.warning("Browser stream invalid message (connection=%s, error=%s, length=%d)",
                               self.connection_id, type(error).__name__, len(raw))
                await self.send({"t": "reject", "id": None, "why": _safe_rejection(error)})
                continue
            if message.get("t") == "ack":
                seq = message.get("seq")
                if not self._closed and type(seq) is int and type(message.get("displayed")) is bool:
                    retired = self._retired_bytes.pop(seq, None)
                    if retired is not None:
                        self._record_ack(seq, retired - FRAME_OVERHEAD)
                        self._acked_retired_frames += 1
                        if self.window.blocked(received_at, self.outstanding, self._pending_size(),
                                               in_flight_bytes=self.in_flight_bytes) == "none":
                            self._end_credit_wait(received_at)
                            self._pause(None, received_at)
                        if self.pending is not None:
                            self.frame_wake.set()
                        continue
                    sample = self.outstanding.pop(seq, None)
                    if sample is not None:
                        started, size, reason, sample_tier = sample
                        self.ack_wait_ms = (received_at - started) * 1000
                        self._record_ack(seq, size, self.ack_wait_ms)
                        self._measure("ack_wait_ms", self.ack_wait_ms)
                        if reason != "idle-refresh":
                            self.window.sample(received_at, self.ack_wait_ms,
                                               outstanding=len(self.outstanding), started=started)
                            # Old encoder pairs still measure this view's link;
                            # retired page ACKs above only return their bytes.
                            self.window.delivered(received_at, started, size, sample_tier)
                            self.window.adjust(received_at)
                            self._flush_adjustments_if_full()
                            self._measure("queue_delay_ms", self.window.queue_ms)
                        else:
                            self.window._sample_counts["idle-refresh"] += 1
                        self._diagnostics()
                        if self.window.blocked(received_at, self.outstanding, self._pending_size(),
                                               in_flight_bytes=self.in_flight_bytes) == "none":
                            self._end_credit_wait(received_at)
                            self._pause(None, received_at)
                        if not message["displayed"]:
                            self.sent.pop(seq, None)
                        elif (seq > self._last_displayed_seq and reason != "idle-refresh"
                              and sample_tier == self.quality_tier):
                            self._last_displayed_seq = seq
                            candidate, why = self.window.quality(self.quality_tier, size)
                            if candidate == self.quality_tier:
                                self._quality_candidate, self._quality_samples = None, 0
                            else:
                                self._quality_samples = (self._quality_samples + 1
                                                         if candidate == self._quality_candidate else 1)
                                self._quality_candidate = candidate
                                threshold = QUALITY_CONFIRM_UP if why == "recovered" else QUALITY_CONFIRM_DOWN
                                if self._quality_samples >= threshold:
                                    # Only displayed current-tier ACKs confirm quality.
                                    await self._switch_quality(candidate, why)
                        if self.window.blocked(time.perf_counter(), self.outstanding, self._pending_size(),
                                               in_flight_bytes=self.in_flight_bytes) == "none":
                            self._end_credit_wait(time.perf_counter())
                            self._pause(None, time.perf_counter())
                        if self.pending is not None:
                            self.frame_wake.set()
                continue
            if message.get("t") == "ping":
                try:
                    ping_id = _number(message, "id")
                except StreamRejected as error:
                    logger.warning("Browser stream rejected ping (connection=%s): %s", self.connection_id, error)
                    await self.send({"t": "reject", "id": message.get("id"), "why": str(error)})
                else:
                    await self.send({"t": "pong", "id": ping_id})
                continue
            async with self._view_lock:
                locked_at = time.perf_counter()
                try:
                    await self._sync_pages()
                    if self._closed:
                        return
                    if message.get("t") == "switch_page":
                        target = message.get("target")
                        if not isinstance(target, str) or not target:
                            raise StreamRejected("invalid-target")
                        await self._sync_pages(target)
                        reply = {"t": "page_done", "vp": self.vp}
                    elif message.get("t") == "new_page":
                        if not self.control:
                            raise StreamRejected("read-only")
                        epoch = _integer(message, "epoch", 0, 2**53)
                        target = await self.browser.new_page(self.lease_id, epoch)
                        await self._sync_pages(target)
                        reply = {"t": "page_done", "target": target, "epoch": epoch, "vp": self.vp}
                    else:
                        reply = await self._input(message)
                        if reply["t"] == "input_done":
                            completed_at = time.perf_counter()
                            reply.update(input_lock_wait_ms=(locked_at - received_at) * 1000,
                                         input_cdp_ms=(completed_at - locked_at) * 1000,
                                         input_dispatch_ms=(completed_at - received_at) * 1000)
                            for name in ("input_lock_wait_ms", "input_cdp_ms", "input_dispatch_ms"):
                                self._measure(name, reply[name])
                except (ValueError, LookupError, RuntimeError, TimeoutError, ConnectionError) as error:
                    logger.warning("Browser stream rejected input (connection=%s, id=%r): %s",
                                   self.connection_id, message.get("id"), error)
                    reply = {"t": "reject", "why": _safe_rejection(error)}
                except (NameError, AttributeError, TypeError, AssertionError) as error:
                    # A defective command must not kill an otherwise usable
                    # viewer. Do not catch cancellation, transport failures or
                    # resource exhaustion under a blanket Exception handler.
                    logger.exception("Stream input programming error (%s)", type(error).__name__)
                    self._gesture = None
                    reply = {"t": "reject", "why": "internal-error"}
                await self.send({"id": message.get("id"), **reply})

    def _validate_input(self, message, retained_frame=None):
        snapshot = self.browser.detail(self.lease_id)
        if snapshot["state"] != "human":
            raise StreamRejected("not-human")
        epoch = _integer(message, "epoch", 0, 2**53)
        if epoch != snapshot["epoch"]:
            raise StreamRejected("stale-epoch")
        if _integer(message, "vp", 0, 2**53) != self.vp:
            raise StreamRejected("stale-viewport")
        frame = _integer(message, "frame", 1, 2**53)
        credential = self.sent.get(frame) if retained_frame is None else retained_frame
        if credential != (epoch, self.vp, self.page):
            raise StreamRejected("stale-frame")
        if self.page is None:
            raise StreamRejected("no-page")
        return epoch

    async def _input(self, message):
        if not self.control:
            raise StreamRejected("read-only")
        if self.page is None:
            raise StreamRejected("no-page")
        epoch = _integer(message, "epoch", 0, 2**53)
        kind = message.get("t")
        input_id = message.get("id")  # Completion id, not a staged gesture's start id.
        commands = []
        if kind == "text":
            text = message.get("text")
            if not isinstance(text, str) or not text or len(text.encode("utf-16-le")) // 2 > MAX_TEXT:
                raise StreamRejected("invalid-text")
            commands.append(("Input.insertText", {"text": text}))
        elif kind == "key":
            key, code = message.get("key"), message.get("code")
            if not all(isinstance(s, str) and 0 < len(s) <= 64 for s in (key, code)):
                raise StreamRejected("invalid-key")
            params = {"key": key, "code": code,
                      "windowsVirtualKeyCode": _integer(message, "vk", 0, 255),
                      "modifiers": _integer(message, "modifiers", 0, 15, 0)}
            text = message.get("text", "")
            if not isinstance(text, str) or len(text) > 16:
                raise StreamRejected("invalid-key-text")
            commands = [("Input.dispatchKeyEvent", {**params, "type": "keyDown" if text else "rawKeyDown",
                         **({"text": text, "unmodifiedText": text} if text else {})}),
                        ("Input.dispatchKeyEvent", {**params, "type": "keyUp"})]
        elif kind in ("navigate", "back", "forward", "reload"):
            if kind == "navigate":
                url = message.get("url")
                if not isinstance(url, str) or len(url) > 8192 or urlsplit(url).scheme not in ("http", "https"):
                    raise StreamRejected("invalid-url")
                commands = [("Page.navigate", {"url": url})]
            elif kind == "reload":
                commands = [("Page.reload", {})]
            else:
                history = await self.browser.page_call(self.lease_id, self.page, "Page.getNavigationHistory")
                index = history["currentIndex"] + (-1 if kind == "back" else 1)
                if not 0 <= index < len(history["entries"]):
                    raise StreamRejected("no-history")
                commands = [("Page.navigateToHistoryEntry", {"entryId": history["entries"][index]["id"]})]
        elif kind in ("move", "down", "up", "click", "wheel", "touch"):
            x, y = _number(message, "x"), _number(message, "y")
            if not (0 <= x < self.css[0] and 0 <= y < self.css[1]):
                raise StreamRejected("out-of-bounds")
            params = {"x": x, "y": y}
            if kind == "wheel":
                params.update(type="mouseWheel", deltaX=_number(message, "dx", 0), deltaY=_number(message, "dy"))
            elif kind == "touch":
                phase = message.get("phase")
                if phase not in ("start", "move", "end", "cancel"):
                    raise StreamRejected("invalid-touch-phase")
                commands = [("Input.dispatchTouchEvent", {"type": "touch" + phase.title(),
                             "touchPoints": [] if phase in ("end", "cancel") else [{"x": x, "y": y, "id": 0}]})]
            elif kind == "move":
                buttons = _integer(message, "buttons", 0, 7, 0)
                params.update(type="mouseMoved", buttons=buttons, button="left" if buttons & 1 else "none")
            else:
                button = message.get("button", "left")
                if not isinstance(button, str) or button not in BUTTONS:
                    raise StreamRejected("invalid-button")
                count = _integer(message, "count", 1, 3, 1)
                params.update(button=button, clickCount=count)
                if kind == "click":
                    commands = [("Input.dispatchMouseEvent", {**params, "type": "mousePressed", "buttons": BUTTONS[button]}),
                                ("Input.dispatchMouseEvent", {**params, "type": "mouseReleased", "buttons": 0})]
                else:
                    params.update(type="mousePressed" if kind == "down" else "mouseReleased",
                                  buttons=BUTTONS[button] if kind == "down" else 0)
            if not commands:
                commands = [("Input.dispatchMouseEvent", params)]
        else:
            raise StreamRejected("unknown-input")
        # Raw mouse/touch phases are assembled locally, never left pressed in
        # Chrome between messages. Retain the validated starting frame even if
        # newer frames evict it from the socket's bounded sent history.
        starts = kind == "down" or kind == "touch" and message["phase"] == "start"
        ends = kind == "up" or kind == "touch" and message["phase"] in ("end", "cancel")
        family = "touch" if kind == "touch" else "mouse"
        retained_frame = None
        if starts:
            self._validate_input(message)
            self._gesture = (family, message, commands, self.sent[message["frame"]])
            return {"t": "input_pending"}
        if self._gesture is not None and (ends or kind in ("move", "touch")):
            expected, initial, accumulated, retained_frame = self._gesture
            if (family != expected or len(accumulated) >= 256
                    or kind == "up" and message.get("button", "left") != initial.get("button", "left")):
                self._gesture = None
                raise StreamRejected("invalid-gesture")
            accumulated.extend(commands)
            if not ends:
                return {"t": "input_pending"}
            self._gesture = None
            commands, message = accumulated, initial
            epoch = _integer(message, "epoch", 0, 2**53)
        elif ends or kind == "touch":
            raise StreamRejected("incomplete-gesture")
        dispatch_view = (self.page, epoch, self.vp)
        dispatched_at = None

        def mark_dispatched():
            nonlocal dispatched_at
            dispatched_at = time.time()

        await self.browser.human_batch(
            self.lease_id, self.page, epoch, commands,
            validate=lambda: self._validate_input(message, retained_frame),
            on_dispatch=mark_dispatched,
        )
        if kind in ("navigate", "reload", "back", "forward"):
            self._invalidate()
            dispatch_view = (dispatch_view[0], epoch, self.vp)
        if (dispatched_at is not None and type(input_id) is int and 0 <= input_id <= 2**53
                and dispatch_view == (self.page, epoch, self.vp)):
            self._applied_dispatches.append((input_id, dispatched_at))
            # Very late frames older than this history remain unattributed.
            if len(self._applied_dispatches) > INPUT_MARKER_HISTORY:
                del self._applied_dispatches[:-INPUT_MARKER_HISTORY]
            # _receive owns the view lock: a frame offered during the CDP
            # round-trip is still in the slot, so reconcile it before send.
            if self.pending is not None and self.pending[1:3] == (epoch, self.vp):
                params, pending_epoch, pending_vp, _ = self.pending
                self.pending = (params, pending_epoch, pending_vp, self._applied_id(params["metadata"]))
        return {"t": "input_done", "epoch": epoch, "vp": self.vp}


async def browser_stream(websocket: WebSocket):
    """Device-authenticated page stream; revocation cancels only this device's viewers."""
    auth = websocket.app.state.device_auth
    identity = auth.identify(websocket.headers.get("authorization"))
    if identity is None:
        await websocket.send_denial_response(JSONResponse(
            {"error": {"code": "unauthorized", "message": "缺少或错误的访问令牌"}},
            status_code=401,
        ))
        return
    mode = websocket.query_params.get("mode", "view")
    if mode not in ("view", "control"):
        await websocket.close(code=4400)
        return
    query = websocket.query_params
    window_values = query.getlist("max_in_flight") if hasattr(query, "getlist") else (
        [query["max_in_flight"]] if "max_in_flight" in query else [])
    window = window_values[0] if window_values else None
    fps_values = query.getlist("fps") if hasattr(query, "getlist") else ([query["fps"]] if "fps" in query else [])
    fps = fps_values[0] if fps_values else str(DEFAULT_FPS)
    if (len(window_values) > 1 or len(fps_values) > 1
            or window is not None and window not in tuple(str(n) for n in range(1, MAX_IN_FLIGHT + 1))
            or fps not in tuple(str(n) for n in range(12, 31))):
        await websocket.close(code=4400)
        return
    runtime = websocket.app.state.gateway.runtime
    browser = runtime.browser if runtime else None
    if browser is None:
        await websocket.close(code=4404)
        return
    ident = websocket.path_params["browser_task_id"]
    try:
        browser.detail(ident)
    except LookupError:
        await websocket.close(code=4404)
        return
    await websocket.accept()
    revoked = asyncio.Event()
    stream_task = None

    def cancel_stream() -> None:
        if stream_task is not None and not stream_task.done() and not stream_task.cancelling():
            stream_task.cancel()

    def stop() -> None:
        revoked.set()
        cancel_stream()

    unsubscribe = auth.register(identity["device_id"], stop)
    if unsubscribe is None:
        await websocket.close(code=4401)
        return
    try:
        stream_task = asyncio.create_task(
            BrowserStream(websocket, browser, ident, control=mode == "control",
                          max_in_flight=int(window) if window is not None else None, fps=int(fps)).run()
        )
        revoke_wait = asyncio.create_task(revoked.wait())
        try:
            done, _ = await asyncio.wait((stream_task, revoke_wait), return_when=asyncio.FIRST_COMPLETED)
            if revoked.is_set():
                # Authentication ownership ends immediately; close delivery has
                # its own transport-level deadline in the gateway server.
                unsubscribe()
                await websocket.close(code=4401)
            else:
                stream_task.result()
        finally:
            revoke_wait.cancel()
            # Reuse the revocation request; a second cancel would interrupt teardown.
            cancel_stream()
            await asyncio.gather(revoke_wait, stream_task, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    except (ConnectionError, TimeoutError):
        await websocket.close(code=1011)
    finally:
        unsubscribe()
