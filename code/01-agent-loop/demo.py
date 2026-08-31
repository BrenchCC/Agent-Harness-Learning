"""第 1 节演示：使用 OpenAI API 进行两轮中文对话。

    python code/01-agent-loop/demo.py
"""
import os
import sys

from openai import OpenAI
from dotenv import load_dotenv

# Add project root to Python path / 将项目根目录加入 Python 路径
sys.path.append(os.getcwd())

from loop import TOOL_SCHEMAS, run_turn

load_dotenv(override = True)

SYSTEM = "你是一个简洁的智能体。请使用提供的工具回答问题。"
MODEL = os.environ.get("MODEL")
API_KEY = os.environ.get("LLM_API_KEY")
BASE_URL = os.environ.get("LLM_BASE_URL")

TURNS = [
    "现在几点？请用一句话回答。",
    "刚才那个时间是 UTC 中午之前还是之后？",
]


def demo():
    """Run the live two-turn OpenAI agent demo."""
    if not API_KEY or not BASE_URL or not MODEL:
        print("01 agent_loop：请在 .env 中设置 LLM_BASE_URL、LLM_API_KEY 和 MODEL。")
        return

    client = OpenAI(api_key = API_KEY, base_url = BASE_URL)

    def model(messages):
        """Call the OpenAI-compatible Chat Completions API.

        Args:
            messages: Conversation messages stored in the agent loop.

        Returns:
            An OpenAI ChatCompletion response.
        """
        return client.chat.completions.create(
            model = MODEL,
            messages = messages,
            tools = TOOL_SCHEMAS,
            max_tokens = 1024,
        )

    messages = []
    for user_text in TURNS:
        messages.append({"role": "user", "content": user_text})
        reply = run_turn(messages, model)
        print("你 ->", user_text)
        print("01 agent_loop ->", reply)


if __name__ == "__main__":
    demo()
