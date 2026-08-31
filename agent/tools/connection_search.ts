import { defineDynamic, disableTool } from "eve/tools";
import { ownerCapabilitiesAllowed } from "../lib/tenant-capabilities.ts";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      ownerCapabilitiesAllowed(ctx) ? null : disableTool(),
    "turn.started": (_event, ctx) =>
      ownerCapabilitiesAllowed(ctx) ? null : disableTool(),
    "step.started": (_event, ctx) =>
      ownerCapabilitiesAllowed(ctx) ? null : disableTool(),
  },
});
