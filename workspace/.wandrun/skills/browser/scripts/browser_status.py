#!/usr/bin/env python3
"""Read browser lease status and local memory without connecting to Chrome.

Only the Python standard library is required. Path options replace Linux proc
inputs for diagnostics/tests; mountinfo must describe the visible cgroup mounts.
"""

import argparse
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import urllib.error
import urllib.request


LOW_MEMORY_BYTES = 1024 ** 3
LOW_MEMORY_PERCENT = 15
STATUS_TIMEOUT_SECONDS = 5
STATES = {
    "unallocated": "尚未分配浏览器（本次检查不会启动 Chrome）",
    "agent": "Agent 控制中",
    "requested": "已请求用户接管",
    "revoking": "正在收回 Agent 控制权，请勿操作",
    "human": "用户控制中，请等待交还后再操作",
    "stopping": "正在停止，请勿新建页面",
    "released": "租约已释放",
}


def read_browser_status():
    endpoint = os.environ.get("WANDRUN_BROWSER_CDP", "").strip()
    if not endpoint:
        raise ValueError("未注入 WANDRUN_BROWSER_CDP，无法读取本任务浏览器状态")
    url = endpoint.rstrip("/") + "/json/wandrun/status"
    try:
        response = urllib.request.urlopen(url, timeout=STATUS_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise ValueError("浏览器状态接口返回 HTTP %s" % error.code) from error
        response = error
    except (OSError, ValueError, http.client.HTTPException) as error:
        raise ValueError("浏览器状态接口不可达：%s" % error) from error
    with response:
        status_code = response.code
        try:
            status = json.load(response)
        except (ValueError, UnicodeError, OSError, http.client.HTTPException) as error:
            raise ValueError("浏览器状态接口响应不可读取或不是有效 JSON") from error
    if not isinstance(status, dict):
        raise ValueError("浏览器状态接口返回格式不完整")
    if status_code == 409 and "state" not in status:
        raise ValueError("浏览器授权不可用：%s" % status.get("error", "授权已过期"))
    capacity = status.get("capacity")
    if (not isinstance(status.get("state"), str) or status["state"] not in STATES
            or not isinstance(capacity, dict)
            or type(status.get("pages_used")) is not int or status["pages_used"] < 0
            or any(type(capacity.get(key)) is not int or capacity[key] < 0
                   for key in ("pages_used", "pages_limit", "pages_registered",
                               "pages_creating", "pages_pending_cleanup"))
            or "reason" not in status
            or (status["reason"] is not None and not isinstance(status["reason"], str))):
        raise ValueError("浏览器状态接口返回格式不完整")
    # A stale control epoch can still supply a complete, useful status snapshot.
    if status_code == 409 and not isinstance(status.get("error"), str):
        raise ValueError("浏览器状态接口的 HTTP 409 缺少授权提示")
    return status


def read_meminfo(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition(":")
        if separator and name in ("MemTotal", "MemAvailable"):
            parts = value.split()
            if len(parts) != 2 or parts[1] != "kB" or not parts[0].isdigit():
                raise ValueError("%s 的 %s 格式无效" % (path, name))
            values[name] = int(parts[0]) * 1024
    if "MemTotal" not in values or "MemAvailable" not in values:
        raise ValueError("%s 缺少 MemTotal/MemAvailable" % path)
    if values["MemTotal"] <= 0 or values["MemAvailable"] > values["MemTotal"]:
        raise ValueError("%s 的内存总量/可用量无效" % path)
    return values["MemTotal"], values["MemAvailable"]


def unescape_mount_path(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


def cgroup_directory(proc_cgroup, mountinfo):
    """Map process membership through mount roots, including cgroup namespaces."""
    membership = None
    for line in proc_cgroup.read_text(encoding="utf-8").splitlines():
        fields = line.split(":", 2)
        if len(fields) == 3 and fields[:2] == ["0", ""]:
            membership = PurePosixPath(fields[2])
            break
    if membership is None:
        return None
    if not membership.is_absolute() or ".." in membership.parts:
        raise ValueError("无法定位进程所属 cgroup：%s" % membership)
    mounts = []
    for line in mountinfo.read_text(encoding="utf-8").splitlines():
        before, separator, after = line.partition(" - ")
        fields = before.split()
        if separator and after.split()[:1] == ["cgroup2"] and len(fields) >= 5:
            root = PurePosixPath(unescape_mount_path(fields[3]))
            mount = Path(unescape_mount_path(fields[4]))
            mounts.append((root, mount))
    if not mounts:
        raise ValueError("进程属于 cgroup v2，但未找到可见挂载")
    matches = [(root, mount) for root, mount in mounts if membership.is_relative_to(root)]
    if matches:
        # Prefer the widest visible hierarchy so bind-mounted subtrees do not
        # hide a stricter ancestor that is also readable through another mount.
        root, mount = min(matches, key=lambda item: len(item[0].parts))
        return mount / str(membership.relative_to(root)), mount
    # A cgroup namespace makes /proc/self/cgroup relative to its namespace
    # root, while mountinfo can still expose the host-relative mount root.
    root, mount = min(mounts, key=lambda item: len(item[0].parts))
    return mount / str(membership.relative_to("/")), mount


def read_cgroups(proc_cgroup, mountinfo):
    located = cgroup_directory(proc_cgroup, mountinfo)
    if located is None:
        return []
    directory, mount = located
    if not directory.is_dir():
        raise ValueError("进程所属 cgroup 目录不可读取：%s" % directory)
    groups = []
    while True:
        maximum_path = directory / "memory.max"
        current_path = directory / "memory.current"
        # The cgroup v2 root or a hierarchy without the memory controller can
        # legitimately have neither file; a half-present pair is not complete.
        if maximum_path.exists() or current_path.exists():
            maximum_text = maximum_path.read_text(encoding="utf-8").strip()
            current_text = current_path.read_text(encoding="utf-8").strip()
            if not current_text.isdigit() or (maximum_text != "max" and not maximum_text.isdigit()):
                raise ValueError("%s 的 memory.max/current 格式无效" % directory)
            maximum = None if maximum_text == "max" else int(maximum_text)
            current = int(current_text)
            groups.append({
                "path": str(directory),
                "max_bytes": maximum,
                "current_bytes": current,
                "available_bytes": None if maximum is None else max(0, maximum - current),
            })
        if directory == mount:
            return groups
        directory = directory.parent


def read_memory(meminfo, proc_cgroup, mountinfo):
    memory = {
        "host_total_bytes": None, "host_available_bytes": None,
        "cgroups": [], "total_bytes": None, "available_bytes": None,
        "available_percent": None, "low": False,
    }
    errors = []
    try:
        total, available = read_meminfo(meminfo)
        memory.update(host_total_bytes=total, host_available_bytes=available)
    except (OSError, ValueError, UnicodeError) as error:
        errors.append("内存 meminfo 不可读取：%s" % error)
    try:
        memory["cgroups"] = read_cgroups(proc_cgroup, mountinfo)
    except (OSError, ValueError, UnicodeError) as error:
        errors.append("内存 cgroup 不可读取：%s" % error)
    totals = [memory["host_total_bytes"]] if memory["host_total_bytes"] is not None else []
    available_values = [memory["host_available_bytes"]] if memory["host_available_bytes"] is not None else []
    for group in memory["cgroups"]:
        if group["max_bytes"] is not None:
            totals.append(group["max_bytes"])
            available_values.append(group["available_bytes"])
    if totals:
        memory["total_bytes"] = min(totals)
        memory["available_bytes"] = min(available_values)
        total = memory["total_bytes"]
        available = memory["available_bytes"]
        memory["available_percent"] = available * 100 / total if total else None
        memory["low"] = (available < LOW_MEMORY_BYTES
                         or available * 100 < total * LOW_MEMORY_PERCENT)
    return memory, "；".join(errors) or None


def gib(value):
    return "%.2f GiB" % (value / 1024 ** 3)


def print_summary(report):
    status = report["browser"]
    if status is None:
        print("浏览器：无法检查；" + report["browser_error"])
    else:
        capacity = status["capacity"]
        print("浏览器：%s；本租约页面 %s；本环境页面 %s/%s（创建中 %s，待清理 %s）。" % (
            STATES[status["state"]], status["pages_used"],
            capacity["pages_used"], capacity["pages_limit"],
            capacity["pages_creating"], capacity["pages_pending_cleanup"]))
        notices = [status[key] for key in ("reason", "error") if status.get(key)]
        if notices:
            print("浏览器提示：" + "；".join(notices))
    memory = report["memory"]
    if memory["total_bytes"] is not None:
        percent = memory["available_percent"]
        print("本环境内存：可用 %s / 总量 %s%s（采用本机与可见 cgroup 的较紧值）。" % (
            gib(memory["available_bytes"]), gib(memory["total_bytes"]),
            "，%.1f%%" % percent if percent is not None else ""))
    for group in memory["cgroups"]:
        print("cgroup：%s；上限 %s，当前 %s。" % (
            group["path"], "max（不设上限）" if group["max_bytes"] is None else gib(group["max_bytes"]),
            gib(group["current_bytes"])))
    if report["memory_error"]:
        print("内存：无法完整检查；" + report["memory_error"])
    for warning in report["warnings"]:
        print("提示：" + warning)


def main():
    parser = argparse.ArgumentParser(description="只读检查浏览器状态与本环境内存，不启动 Chrome。")
    parser.add_argument("--json", action="store_true", help="输出 JSON（字节单位）")
    parser.add_argument("--meminfo", type=Path, default=Path("/proc/meminfo"))
    parser.add_argument("--proc-cgroup", type=Path, default=Path("/proc/self/cgroup"))
    parser.add_argument("--mountinfo", type=Path, default=Path("/proc/self/mountinfo"))
    args = parser.parse_args()
    report = {"browser": None, "browser_error": None}
    try:
        report["browser"] = read_browser_status()
    except (OSError, ValueError, UnicodeError) as error:
        report["browser_error"] = str(error)
    report["memory"], report["memory_error"] = read_memory(args.meminfo, args.proc_cgroup, args.mountinfo)
    report["warnings"] = []
    if report["memory"]["low"]:
        report["warnings"].append(
            "可用内存低于 %g GiB 或总量的 %s%%，新建页面前建议关闭不用的页面；"
            "这只是提示，不是硬性限制。" % (LOW_MEMORY_BYTES / 1024 ** 3, LOW_MEMORY_PERCENT))
    report["complete"] = report["browser_error"] is None and report["memory_error"] is None
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print_summary(report)
    return 0 if report["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
