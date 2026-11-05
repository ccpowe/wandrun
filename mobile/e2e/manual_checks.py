"""Only OS handoffs that require a human; absence of a receipt is a failure, never a skip."""
import json
import os
import subprocess
import time
from urllib.parse import urlencode

import segno


def check(runner, name, instructions):
    runner.begin_phase("manual-" + name)
    started = time.monotonic()
    prompt = instructions + "\n请实际完成并回到 Expo Go；回复以“通过”“部分通过”或“未通过”开头并说明缺项。部分通过不记 PASS；面板出现不等于保存或接收成功。"
    command = os.environ.get("E2E_MANUAL_COMMAND")
    if command:
        argv = json.loads(command)
        if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
            raise ValueError("E2E_MANUAL_COMMAND must be a JSON argv array")
        result = subprocess.run([*argv, "--question", prompt, "--options", "通过,部分通过,未通过"], capture_output=True, text=True, timeout=660)
        if result.returncode:
            raise RuntimeError("Manual receipt command failed: " + result.stderr)
        reply = result.stdout.strip()
    else:
        try:
            reply = input(prompt + "\n> ").strip()
        except EOFError as error:
            raise RuntimeError("人工检查需要交互终端或 E2E_MANUAL_COMMAND，不能跳过") from error
    status = "PASS" if reply.startswith("通过") else "PARTIAL" if reply.startswith("部分通过") else "FAIL"
    uncovered = (["camera-permission-denied"] if name == "pairing-camera"
                 and os.environ.get("E2E_CAMERA_PERMISSION_PREGRANTED") == "1" else [])
    if status == "PASS" and uncovered:
        status = "PARTIAL"
    receipt = {"name": name, "seconds": round(time.monotonic() - started, 2),
               "status": status, "passed": status == "PASS", "reply": reply, "uncovered": uncovered}
    runner.manual_results.append(receipt)
    (runner.OUT / "manual-results.json").write_text(json.dumps(runner.manual_results, ensure_ascii=False, indent=2))
    if status == "FAIL":
        raise AssertionError("人工原生检查未通过：" + name)


def pairing_camera(runner, pairing, env):
    pairing.issue(env["PAIR_DEVICE_NAME"])
    target = runner.OUT / "private-pairing-qr.svg"
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            segno.make("wandrun://pair?" + urlencode({"url": env["PAIRING_URL"], "code": pairing.code}), error="m").save(output, kind="svg", scale=6, dark="black", light="white")
        permission = (
            "本轮用户已确认相机权限预先授予，不撤销权限、不复测拒绝路径；该缺项固定记未覆盖，扫码通过也不把整个相机子场景记 PASS。只请扫描并停在实际到达页面，以“通过/未通过”开头说明结果。"
            if os.environ.get("E2E_CAMERA_PERMISSION_PREGRANTED") == "1" else
            "拒绝路径的前置条件是用户在系统设置中撤销 Expo Go 已有相机权限。先拒绝并确认仍可手动输入，再允许权限；前置条件未满足请明确回复部分通过。"
        )
        check(runner, "pairing-camera", (
            "配对 / 相机权限人工子场景。当前平板停在新增连接页，二维码在本机 0600 文件 " + str(target) + "（5 分钟内有效，请在另一屏显示；不要复制配对码到回复）。"
            + permission + " Agent 不操作系统设置。用真实相机扫描后停在自动到达的页面，不另行导航，Agent 会独立核对聊天；不要仅因扫码器识别到图案就宣称已到聊天。"))
        env["PAIRING_METHOD"] = "扫码"
    finally:
        target.unlink(missing_ok=True)
