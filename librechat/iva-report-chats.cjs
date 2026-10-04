const { createHash } = require("node:crypto");

function stableId(key) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Native LibreChat models render these as ordinary conversations, including Markdown,
// attachments and the standard composer. The archive remains the source of the report.
function createReportChats({ models, receipts, refreshStats }) {
  const pending = new Map();
  async function lookup(user, id) {
    const receipt = await receipts.findOne({ _id: `${user}:${id}` });
    if (!receipt?.complete) return undefined;
    const conversation = await models.Conversation.findOne({
      user,
      conversationId: receipt.conversationId,
    }).lean();
    return conversation
      ? {
          conversationId: receipt.conversationId,
          projectId: conversation.chatProjectId,
        }
      : null;
  }
  async function ensure(user, detail) {
    const report = detail.notification;
    if (report.kind !== "report") return null;
    const conversationId = stableId(`iva-report\0${user}\0${report.id}`);
    const key = `${user}:${report.id}`;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const receipt = await receipts.findOne({ _id: key });
      if (receipt?.complete) {
        // A user's deletion or move must survive archive polling.
        const conversation = await models.Conversation.findOne({
          user,
          conversationId,
        }).lean();
        return conversation
          ? { conversationId, projectId: conversation.chatProjectId }
          : null;
      }
      let project = await models.ChatProject.findOne({
        user,
        name: "Входящие Ивы",
      }).lean();
      if (!project) {
        const projectId = createHash("sha256")
          .update(`iva-inbox\0${user}`)
          .digest("hex")
          .slice(0, 24);
        project = await models.ChatProject.findOneAndUpdate(
          { _id: projectId, user },
          {
            $setOnInsert: {
              user,
              name: "Входящие Ивы",
              description: "Отчёты Ивы и их обсуждения",
            },
          },
          { upsert: true, new: true },
        ).lean();
      }
      const projectId = String(project._id);
      const createdAt = new Date(report.createdAt);
      await models.Conversation.findOneAndUpdate(
        { user, conversationId },
        {
          $setOnInsert: {
            user,
            conversationId,
            title: report.title,
            endpoint: "Iva",
            endpointType: "custom",
            model: "iva",
            chatProjectId: projectId,
            isArchived: false,
            createdAt,
            updatedAt: createdAt,
          },
        },
        { upsert: true, new: true, timestamps: false },
      );
      let parentMessageId = "00000000-0000-0000-0000-000000000000";
      const transcript = [
        { role: "assistant", body: report.body, createdAt: report.createdAt },
        ...(detail.messages || []),
      ];
      const messageIds = [];
      for (let index = 0; index < transcript.length; index++) {
        const message = transcript[index];
        const messageId = stableId(`${conversationId}\0${index}`);
        const stored = await models.Message.findOneAndUpdate(
          { user, messageId },
          {
            $setOnInsert: {
              user,
              conversationId,
              messageId,
              parentMessageId,
              sender: message.role === "user" ? "User" : "Iva",
              isCreatedByUser: message.role === "user",
              text: message.body,
              model: "iva",
              endpoint: "Iva",
              unfinished: false,
              error: false,
              createdAt: new Date(message.createdAt),
              updatedAt: new Date(message.createdAt),
            },
          },
          { upsert: true, new: true, timestamps: false },
        );
        messageIds.push(stored._id);
        parentMessageId = messageId;
      }
      await models.Conversation.updateOne(
        { user, conversationId },
        { $addToSet: { messages: { $each: messageIds } } },
        { timestamps: false },
      );
      await refreshStats(user, projectId);
      await receipts.updateOne(
        { _id: key },
        { $set: { complete: true, conversationId, projectId } },
        { upsert: true },
      );
      return { conversationId, projectId };
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }
  return { ensure, lookup };
}

module.exports = { createReportChats, stableId };
