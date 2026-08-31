"""智能体循环（第 1 节）：围绕 OpenAI 工具调用的核心循环。

这里有两层循环：内层完成一次用户请求，模型需要工具时执行工具并将结果回传；
外层由调用方维护同一个 messages 列表，因此下一轮仍能看到完整的历史上下文。
"""
import json
from datetime import datetime, timezone


def get_time(_input):
    """Return the current UTC time.

    Args:
        _input: Unused tool arguments.

    Returns:
        Current UTC time in ISO 8601 format.
    """
    return datetime.now(timezone.utc).isoformat(timespec = "seconds")


TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_time",
            "description": "返回当前 UTC 时间，格式为 ISO 8601 字符串。",
            "parameters": {"type": "object", "properties": {}},
        },
    }
]

HANDLERS = {"get_time": get_time}


def run_tool(name, tool_input):
    """Run one registered tool and return its text result.

    Args:
        name: Name of the requested tool.
        tool_input: Parsed JSON arguments supplied by the model.

    Returns:
        The tool result, or an error message.
    """
    fn = HANDLERS.get(name)
    if fn is None:
        return f"错误：不存在工具 {name!r}"
    try:
        return fn(tool_input)
    except Exception as error:
        return f"错误：{error}"


def _message_to_dict(message):
    """Convert an OpenAI message object to a serializable dictionary.

    Args:
        message: An OpenAI Chat Completions message object or dictionary.

    Returns:
        A message dictionary accepted by the next API call.
    """
    if isinstance(message, dict):
        return message
    return message.model_dump(exclude_none = True)


def run_turn(messages, model, max_steps = 10):
    """Run one user turn to completion over the shared message list.

    Args:
        messages: Conversation messages; the newest user message is already present.
        model: Callable that accepts messages and returns an OpenAI completion.
        max_steps: Maximum model-tool iterations allowed for one user turn.

    Returns:
        The assistant's final text response.

    Raises:
        RuntimeError: If the model exceeds the allowed tool-call iterations.
    """
    for _ in range(max_steps):
        response = model(messages)
        assistant_message = _message_to_dict(response.choices[0].message)
        messages.append(assistant_message)

        tool_calls = assistant_message.get("tool_calls", [])
        if not tool_calls:
            return assistant_message.get("content") or ""

        for tool_call in tool_calls:
            function = tool_call["function"]
            tool_input = json.loads(function["arguments"] or "{}")
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "content": run_tool(function["name"], tool_input),
                }
            )

    raise RuntimeError("工具调用次数超过最大限制")


def final_text(response):
    """Extract final assistant text from an OpenAI completion.

    Args:
        response: An OpenAI ChatCompletion response.

    Returns:
        The assistant text, or an empty string when absent.
    """
    return response.choices[0].message.content or ""
