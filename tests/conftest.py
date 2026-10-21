"""测试不得连接默认配置里的 127.0.0.1:9222：那通常是开发者正在用的 Chrome，
运行时接入时会关闭其中的已有页面。需要浏览器的测试用 ChromeDev 的随机端口。"""

import pytest

from wandrun.runtime.browser import BrowserLeases

_start = BrowserLeases.start


async def _start_unless_default_chrome(self):
    if self.config.cdp_url.rstrip("/") == "http://127.0.0.1:9222":
        raise AssertionError("测试使用了默认 Chrome 地址；改写 environments.toml 去掉浏览器或换用 ChromeDev")
    return await _start(self)


@pytest.fixture(autouse=True)
def _keep_tests_off_default_chrome(monkeypatch):
    monkeypatch.setattr(BrowserLeases, "start", _start_unless_default_chrome)
