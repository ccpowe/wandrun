"""ADR-0009：续聊时判定最近一次发送响应是否被接收的规则。"""

import json
import unittest

from langchain.messages import AIMessage, HumanMessage

from wandrun.runtime.messages import (
    AgentOutput,
    SendMessage,
    runtime_message,
    unaccepted_send_notice,
)


def response(message_id, *messages):
    output = AgentOutput(messages=list(messages), next="wait")
    return AIMessage(
        content=output.model_dump_json(),
        id=message_id,
        additional_kwargs={"wandrun_agent_output": output.model_dump()},
    )


def receipt(response_id):
    return runtime_message({"deliveries": []}, receipt_for=response_id)


WORKER = SendMessage(to="executor", task_id=None, message="work")
HUMAN = SendMessage(to="human", task_id=None, message="hello")


class UnacceptedSendNoticeTests(unittest.TestCase):
    def test_no_send_response_needs_no_notice(self):
        self.assertIsNone(unaccepted_send_notice([HumanMessage("goal", id="g"), response("a")], []))

    def test_receipt_in_history_or_inputs_means_accepted(self):
        history = [HumanMessage("goal", id="g"), response("a", WORKER)]
        self.assertIsNone(unaccepted_send_notice([*history, receipt("a")], []))
        self.assertIsNone(unaccepted_send_notice(history, [receipt("a")]))

    def test_receipt_for_another_response_does_not_count(self):
        history = [HumanMessage("goal", id="g"), response("a", WORKER)]
        notice = unaccepted_send_notice(history, [receipt("older")])
        self.assertEqual(notice.id, "undelivered:a")
        data = json.loads(notice.content.split("\n", 1)[1])
        self.assertEqual(data["unaccepted_messages"][0]["to"], "executor")
        self.assertIn("没有创建任务", data["note"])
        self.assertNotIn("可能已经显示", data["note"])

    def test_human_message_is_reported_as_possibly_shown(self):
        notice = unaccepted_send_notice([response("a", HUMAN)], [])
        self.assertIn("可能已经显示", notice.content)
        self.assertNotIn("没有创建任务", notice.content)

    def test_existing_notice_is_not_generated_again(self):
        history = [response("a", WORKER)]
        notice = unaccepted_send_notice(history, [])
        self.assertIsNone(unaccepted_send_notice([*history, notice], []))
        self.assertIsNone(unaccepted_send_notice(history, [notice]))

    def test_only_latest_send_response_is_checked(self):
        # 后面一条响应不带消息，候选仍是 b；更早的 a 没有回执也不追溯。
        history = [response("a", WORKER), response("b", WORKER), receipt("b"), response("c")]
        self.assertIsNone(unaccepted_send_notice(history, []))


if __name__ == "__main__":
    unittest.main()
