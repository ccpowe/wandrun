"""一个执行工作区的默认布局；显式的外部配置和评测产物路径由入口选择。"""

from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path

DEFAULT_CONFIGS = ("agents.toml", "mcps.toml", "environments.toml")


@dataclass(frozen=True)
class Workspace:
    """校验并固定工作目录，不改变进程 cwd；只有 ensure_config 会创建 .wandrun。"""

    root: Path

    def __post_init__(self) -> None:
        root = Path(self.root).resolve(strict=True)
        if not root.is_dir():
            raise ValueError(f"workspace 不是目录: {root}")
        object.__setattr__(self, "root", root)

    @property
    def runtime_dir(self) -> Path:
        return self.root / ".wandrun"

    @property
    def agents_config(self) -> Path:
        return self.runtime_dir / "agents.toml"

    @property
    def mcps_config(self) -> Path:
        return self.runtime_dir / "mcps.toml"

    @property
    def environments_config(self) -> Path:
        return self.runtime_dir / "environments.toml"

    def ensure_config(self) -> bool:
        """.wandrun 不存在时生成默认配置与内置技能（browser、skill-installer），返回是否生成。

        已存在时原样使用，缺少的必需文件由加载配置时报错，不补写。
        """
        if self.runtime_dir.exists():
            return False
        self.skills_dir.mkdir(parents=True)
        defaults = files("wandrun.defaults")
        for name in DEFAULT_CONFIGS:
            (self.runtime_dir / name).write_text(
                defaults.joinpath(name).read_text(encoding="utf-8"), encoding="utf-8"
            )
        for skill in defaults.joinpath("skills").iterdir():
            target = self.skills_dir / skill.name
            target.mkdir()
            (target / "SKILL.md").write_bytes(skill.joinpath("SKILL.md").read_bytes())
        return True

    @property
    def skills_dir(self) -> Path:
        return self.runtime_dir / "skills"

    @property
    def state_dir(self) -> Path:
        return self.runtime_dir / "state"

    @property
    def memory_dir(self) -> Path:
        return self.state_dir / "memory"

    @property
    def checkpoint_path(self) -> Path:
        return self.state_dir / "checkpoints.sqlite"

    @property
    def runs_dir(self) -> Path:
        return self.runtime_dir / "runs"

    @property
    def evaluations_dir(self) -> Path:
        return self.runtime_dir / "evaluations"
