import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import moment from "moment";
import {
  shouldResetChatHistory,
  systemPrompt,
  updateLastMessageTime,
} from "../../config/llm-config";
import { Message } from "../../type";
import {
  ChatWithLLMStreamFunction,
  SummaryTextWithLLMFunction,
} from "../interface";
import { chatHistoryDir } from "../../utils/dir";

dotenv.config();

const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN || "";
const cloudflareModel =
  process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct";

const chatHistoryFileName = `cloudflare_chat_history_${moment().format("YYYY-MM-DD_HH-mm-ss")}.json`;

const messages: Message[] = [
  {
    role: "system",
    content: systemPrompt,
  },
];

const resetChatHistory = (): void => {
  messages.length = 0;
  messages.push({
    role: "system",
    content: systemPrompt,
  });
};

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages: Message[] = [],
  partialCallback: (partial: string) => void,
  endCallback: () => void,
): Promise<void> => {
  if (!cloudflareAccountId || !cloudflareApiToken) {
    console.error("Cloudflare credentials not set.");
    return;
  }

  if (shouldResetChatHistory()) {
    resetChatHistory();
  }
  updateLastMessageTime();

  messages.push(...inputMessages);

  let endResolve: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    endResolve = resolve;
  }).finally(() => {
    fs.writeFileSync(
      path.join(chatHistoryDir, chatHistoryFileName),
      JSON.stringify(messages, null, 2),
    );
  });

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/run/${cloudflareModel}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudflareApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: messages,
          stream: true,
        }),
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`Cloudflare API error: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let partialAnswer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.response) {
              partialCallback(parsed.response);
              partialAnswer += parsed.response;
            }
          } catch (e) {
            console.error("Parse error:", e);
          }
        }
      }
    }

    messages.push({
      role: "assistant",
      content: partialAnswer,
    });

    endResolve();
    endCallback();
  } catch (error: any) {
    console.error("Cloudflare AI error:", error.message);
    endResolve();
    endCallback();
  }

  return promise;
};

const summaryTextWithLLM: SummaryTextWithLLMFunction = async (
  text: string,
  promptPrefix: string,
): Promise<string> => {
  if (!cloudflareAccountId || !cloudflareApiToken) {
    console.error("Cloudflare credentials not set.");
    return text;
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/run/${cloudflareModel}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudflareApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: promptPrefix },
            { role: "user", content: text },
          ],
        }),
      },
    );

    const result = await response.json();
    return result.result?.response || text;
  } catch (error) {
    console.error("Cloudflare summary error:", error);
    return text;
  }
};

export default { chatWithLLMStream, resetChatHistory, summaryTextWithLLM };
