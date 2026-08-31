"""第 1 节离线检查：工具分发、最终文本和多轮记忆。

无需密钥，也不会发送网络请求。

    python code/01-agent-loop/test.py
"""
from types import SimpleNamespace

from loop import final_text, run_tool, run_turn


class _Message:
    """Minimal OpenAI assistant message used by offline tests."""

    def __init__(self, content = None, tool_calls = None):
        """Initialize a fake assistant message.

        Args:
            content: Assistant text content.
            tool_calls: Optional OpenAI-format tool calls.
        """
        self.content = content
        self.tool_calls = tool_calls

    def model_dump(self, exclude_none = True):
        """Return the message in the format stored by the OpenAI loop.

        Args:
            exclude_none: Whether to exclude fields with None values.

        Returns:
            A serializable assistant message dictionary.
        """
        message = {"role": "assistant", "content": self.content}
        if self.tool_calls is not None:
            message["tool_calls"] = self.tool_calls
        if exclude_none:
            return {key: value for key, value in message.items() if value is not None}
        return message


class _Response:
    """Minimal OpenAI ChatCompletion response used by offline tests."""

    def __init__(self, content = None, tool_calls = None):
        """Initialize a fake completion response.

        Args:
            content: Assistant text content.
            tool_calls: Optional OpenAI-format tool calls.
        """
        self.choices = [
            SimpleNamespace(message = _Message(content = content, tool_calls = tool_calls))
        ]


def test():
    """Run offline checks for the current OpenAI agent loop."""
    assert run_tool("get_time", {}).startswith("20")
    assert run_tool("不存在", {}).startswith("错误")
    assert final_text(_Response("你好")) == "你好"

    # 工具调用：assistant tool_calls 后紧跟 role=tool 的结果消息
    tool_seen = {}

    def tool_model(messages):
        """Return a tool call first and a final answer after its result.

        Args:
            messages: Conversation messages visible to the model.

        Returns:
            A minimal OpenAI-compatible response.
        """
        tool_seen["count"] = len(messages)
        if len(messages) == 1:
            return _Response(
                tool_calls = [
                    {
                        "id": "call_time",
                        "type": "function",
                        "function": {"name": "get_time", "arguments": "{}"},
                    }
                ]
            )
        assert messages[-1]["role"] == "tool"
        assert messages[-1]["tool_call_id"] == "call_time"
        return _Response("当前时间已查询。")

    tool_messages = [{"role": "user", "content": "现在几点？"}]
    assert run_turn(tool_messages, tool_model) == "当前时间已查询。"
    assert tool_seen["count"] == 3
    assert tool_messages[1]["tool_calls"][0]["id"] == "call_time"

    # 多轮：复用同一个 messages 列表，第二轮仍能看到第一轮上下文
    seen = {}

    def model(messages):
        """Return a reply that indicates how many messages are visible.

        Args:
            messages: Conversation messages visible to the model.

        Returns:
            A minimal OpenAI-compatible response.
        """
        seen["count"] = len(messages)
        return _Response(f"回复 {len(messages)}")

    messages = [{"role": "user", "content": "第一轮"}]
    assert run_turn(messages, model) == "回复 1"
    assert len(messages) == 2

    messages.append({"role": "user", "content": "第二轮"})
    run_turn(messages, model)
    assert seen["count"] == 3
    assert messages[0]["content"] == "第一轮"

    print("01 agent_loop：离线测试通过")


if __name__ == "__main__":
    test()
