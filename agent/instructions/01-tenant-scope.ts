import { defineDynamic, defineInstructions } from "eve/instructions";
import { tenantProviderScopeMarkdown } from "../lib/tenant-provider-scope.ts";
import { withTenantStoreFromSession } from "../lib/tenant-session.ts";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const markdown = withTenantStoreFromSession(ctx, (store) =>
        tenantProviderScopeMarkdown(store.context),
      );
      return markdown ? defineInstructions({ markdown }) : null;
    },
  },
});
