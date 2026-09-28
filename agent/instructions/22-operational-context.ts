import { defineDynamic, defineInstructions } from "eve/instructions";
import { operationalContextMarkdown } from "../lib/operational-context.ts";

// Shared working state is deliberately independent from conversation sessions.
// Telegram and LibreChat keep separate local histories, while every turn receives the
// same current tasks, projects, people and decisions from the vault/data stores.
export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({ markdown: operationalContextMarkdown() }),
  },
});
