"""Read and remove workspace skills through directory handles anchored below the skills root.

The root and every directory in its path are opened without following symlinks. Reads reject
SKILL.md links; deletion unlinks links (including nested ones) instead of traversing them.
"""

import errno
import logging
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path

import yaml
from deepagents.middleware.skills import MAX_SKILL_DESCRIPTION_LENGTH, _validate_skill_name

from wandrun.config import _skill_names
from wandrun.gateway.capabilities import UI_CAPABILITY

BUILTIN_SKILLS = UI_CAPABILITY.builtin_skills
logger = logging.getLogger(__name__)
RESERVED_SKILL_ERROR = "名称被网关内置技能占用，不生效"

MAX_SKILL_CONTENT_BYTES = 1024 * 1024
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


class InvalidSkill(ValueError):
    """A requested skill name is not one direct child of the skills root."""


class SkillBoundaryError(ValueError):
    """The skills root changed or is not an ordinary directory."""


def validate_skill_path_name(name: str) -> str:
    """An API name can be invalid as a skill, but must still be one POSIX root child."""
    if not isinstance(name, str) or not name or name in {".", ".."} or "/" in name or "\x00" in name:
        raise InvalidSkill("技能名称必须是技能目录中的单个名称，不能是路径")
    return name


@contextmanager
def _open_root(root: Path):
    """Anchor the root by file descriptor; no path component may redirect through a link."""
    parts = root.absolute().parts
    fd = os.open(parts[0], _DIRECTORY_FLAGS)
    try:
        for part in parts[1:]:
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def _skill_description(content: str, name: str) -> str:
    match = _FRONTMATTER.match(content)
    if match is None:
        raise ValueError("SKILL.md 缺少有效的 YAML 头部")
    try:
        fields = yaml.safe_load(match.group(1))
    except RecursionError:
        raise ValueError("SKILL.md 头部 YAML 嵌套过深") from None
    except yaml.YAMLError:
        raise ValueError("SKILL.md 头部 YAML 格式错误") from None
    if not isinstance(fields, dict):
        raise ValueError("SKILL.md 头部必须是字段表")
    if not isinstance(fields.get("name"), str) or not fields["name"].strip():
        raise ValueError("SKILL.md 头部缺少非空的名称")
    valid, reason = _validate_skill_name(fields["name"].strip(), name)
    if not valid:
        logger.info("技能名称校验失败（%s）：%s", name, reason)
        raise ValueError("SKILL.md 名称不合法，请使用与技能目录相同的有效名称")
    description = fields.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("SKILL.md 头部缺少非空的说明")
    description = description.strip()
    if len(description) > MAX_SKILL_DESCRIPTION_LENGTH:
        raise ValueError(f"SKILL.md 的说明超过 {MAX_SKILL_DESCRIPTION_LENGTH} 个字符")
    return description


def inspect_skill(skills_dir: Path, name: str, *, include_content: bool = False) -> dict:
    """Return status/error/description and optional mtime/content for a direct skill entry.

    Invalid entries return a visible error rather than disappearing. Callers enumerate only
    direct entries; URL names have only the path-safety guard so invalid skills remain repairable.
    Gateway builtin names remain readable for repair, but never report an effective user skill.
    """
    result = {"name": name, "description": "", "status": "error", "error": None}
    if include_content:
        result.update(mtime=None, content=None)
    try:
        validate_skill_path_name(name)
        with _open_root(skills_dir) as root_fd:
            directory_fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=root_fd)
            try:
                file_fd = os.open("SKILL.md", _FILE_FLAGS, dir_fd=directory_fd)
                try:
                    info = os.fstat(file_fd)
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError("SKILL.md 不是普通文件")
                    if info.st_size > MAX_SKILL_CONTENT_BYTES:
                        raise ValueError("SKILL.md 超过 1 MiB 上限")
                    with os.fdopen(file_fd, "rb") as skill_file:
                        file_fd = -1
                        content_bytes = skill_file.read(MAX_SKILL_CONTENT_BYTES + 1)
                    if len(content_bytes) > MAX_SKILL_CONTENT_BYTES:
                        raise ValueError("SKILL.md 超过 1 MiB 上限")
                    content = content_bytes.decode("utf-8")
                    if include_content:
                        result.update(mtime=info.st_mtime, content=content)
                    try:
                        _skill_names((name,), "skills")
                    except ValueError as error:
                        logger.info("技能目录名称校验失败（%s）", name, exc_info=True)
                        raise ValueError("技能目录名称不合法，请使用单个有效名称") from error
                    result["description"] = _skill_description(content, name)
                    result.update(status="ok", error=None)
                finally:
                    if file_fd >= 0:
                        os.close(file_fd)
            finally:
                os.close(directory_fd)
    except UnicodeError:
        result["error"] = "SKILL.md 不是 UTF-8 文本"
    except ValueError as error:
        result["error"] = str(error)
    except FileNotFoundError:
        result["error"] = "SKILL.md 或技能目录不存在"
    except OSError as error:
        logger.warning("读取技能失败（%s）", name, exc_info=True)
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            result["error"] = "技能目录或 SKILL.md 是链接或不是普通目录/文件"
        else:
            result["error"] = "无法读取技能，请检查文件权限或网关日志"
    if isinstance(name, str) and name in BUILTIN_SKILLS:
        result.update(status="error", error=RESERVED_SKILL_ERROR)
    return result


def list_skill_names(skills_dir: Path) -> list[str]:
    """List direct directories and links, including entries that cannot load."""
    try:
        with _open_root(skills_dir) as root_fd:
            with os.scandir(root_fd) as entries:
                return sorted(
                    entry.name for entry in entries
                    if entry.is_dir(follow_symlinks=False) or entry.is_symlink()
                )
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            return []
        raise



def _remove_tree(parent_fd: int, name: str) -> None:
    """Unlink files/links by descriptor; never recurse through a link, even on a race."""
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        try:
            os.unlink(name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        return
    try:
        directory_fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return
    try:
        with os.scandir(directory_fd) as children:
            for child in children:
                _remove_tree(directory_fd, child.name)
    finally:
        os.close(directory_fd)
    try:
        os.rmdir(name, dir_fd=parent_fd)
    except FileNotFoundError:
        pass


def delete_skill_directory(skills_dir: Path, name: str) -> bool:
    """Delete only the named root child; return false if already absent.

    The root identity is checked again before mutation and every traversal uses directory
    handles with NOFOLLOW. An external process renaming the already-open root during the
    recursive operation cannot be serialized by the gateway's catalog lock.
    """
    validate_skill_path_name(name)
    try:
        with _open_root(skills_dir) as root_fd:
            try:
                info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                return False
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise SkillBoundaryError("技能条目不是目录或链接，不能删除")
            try:
                with _open_root(skills_dir) as current_fd:
                    current, original = os.fstat(current_fd), os.fstat(root_fd)
                    if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                        raise SkillBoundaryError("技能根目录已被替换，请重试")
                _remove_tree(root_fd, name)
            except (NotADirectoryError, IsADirectoryError) as error:
                raise SkillBoundaryError("技能目录删除时发生替换，请重试") from error
            return True
    except FileNotFoundError:
        return False
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise SkillBoundaryError("技能根目录是链接或已被替换") from error
        raise
