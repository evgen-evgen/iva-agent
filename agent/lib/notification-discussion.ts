import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { loadJsonStrict, saveJsonAtomic } from "./json-store.ts";

export type DiscussionMessage = {
  role: "user" | "assistant";
  body: string;
  createdAt: string;
};
export type Discussion = { messages: DiscussionMessage[] };

export function discussionToken(id: string, principal: string): string {
  return (
    "report:" + createHash("sha256").update(`${principal}\0${id}`).digest("hex")
  );
}

function path(id: string, principal: string): string {
  return join(
    dataDir(),
    "report-discussions",
    discussionToken(id, principal).slice(7) + ".json",
  );
}

export function readDiscussion(
  id: string,
  principal: string,
): Promise<Discussion> {
  return loadJsonStrict(path(id, principal), { messages: [] });
}

// One Eve runtime owns report sessions. Reject simultaneous turns for the same
// account/report, while allowing independent reports and accounts to run.
const busy = new Set<string>();
export async function discussNotification(
  id: string,
  principal: string,
  question: string,
  answer: (history: Discussion) => Promise<string>,
): Promise<Discussion | null> {
  const key = discussionToken(id, principal);
  if (busy.has(key)) return null;
  busy.add(key);
  try {
    const history = await readDiscussion(id, principal);
    const body = await answer(history);
    const next: Discussion = {
      messages: [
        ...history.messages,
        { role: "user", body: question, createdAt: new Date().toISOString() },
        { role: "assistant", body, createdAt: new Date().toISOString() },
      ],
    };
    await saveJsonAtomic(path(id, principal), next);
    return next;
  } finally {
    busy.delete(key);
  }
}
