"""A completed read, not yet delivered, for offline compaction scenarios."""

SUMMARY_TEXT = """## 1. 目标
核对报告数值并交付结果；读取已完成，回复尚未发送。

## 2. 用户约束与偏好原话
never overwrite

## 3. 已确认事实
已读 /reports/a.txt 第 1～80 行，覆盖全文；result=67，信息已足够回答。

## 4. 决策与否决（含理由和更正）
读取步骤已完成；尚未向 human 交付。失败尝试与结果未知项：无。

## 5. 产物与路径
无

## 6. 进行中／下一步
仅剩向 human 发送 result=67，不需要再次读取报告。

## 7. 关键标识（路径、提交号、任务 ID、工具调用 ID、数字和单位原样）
/reports/a.txt；result=67；read-1。"""
