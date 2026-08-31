// Ядро middleware, который прикладывает картинку Vault к сообщению модели. Файлы сюда
// приходят инъекцией (readImage), поэтому тест идёт без файловой системы и без сети.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBlobStore } from "./lib/blob-store.ts";
import { tenantContextForRecord } from "./lib/tenant-context.ts";
import { TenantRegistry } from "./lib/tenant-registry.ts";
import { TenantStore } from "./lib/tenant-store.ts";
import {
  tenantIdFromProviderScope,
  tenantProviderScopeMarkdown,
} from "./lib/tenant-provider-scope.ts";

process.env.MODEL_PROVIDER = "ollama";
process.env.ASSISTANT_BEARER = "provider-test-secret";
const {
  attachImagesMiddleware,
  attachTenantVaultImages,
  attachVaultImages,
  trustedTenantIdInPrompt,
} = await import("./provider.ts");
const { MAX_ATTACHED_IMAGES, MAX_IMAGE_BYTES } =
  await import("./lib/attachment-ref.ts");

type Prompt = Parameters<typeof attachVaultImages>[0];
type Message = Prompt[number];
type FilePart = {
  type: "file";
  mediaType: string;
  data: { type: "data"; data: Uint8Array };
};

const BYTES = new Uint8Array([1, 2, 3]);
const readImage = () => ({ data: BYTES, mediaType: "image/jpeg" });
const attachmentId = (n: number) => `att_${n.toString(16).padStart(32, "0")}`;
const attachmentRef = (n: number) => `attachment:${attachmentId(n)}`;
const REF = attachmentRef(1);

function userText(...texts: string[]): Message {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text" as const, text })),
  };
}

function filesOf(message: Message): FilePart[] {
  const content = (message as { content: { type: string }[] }).content;
  assert.ok(Array.isArray(content));
  return content.filter((part) => part.type === "file") as FilePart[];
}

function muteErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

await test("ссылка в user-сообщении превращается в file-part", () => {
  const [message] = attachVaultImages(
    [userText(`[photo] изображение (${REF}) — приложено.`)],
    { readImage },
  );

  const files = filesOf(message);
  assert.equal(files.length, 1);
  assert.equal(files[0].mediaType, "image/jpeg");
  // filename провайдеры для картинок не читают — его в part нет.
  assert.equal("filename" in files[0], false);
  // Тегированная форма данных — то, что понимает спека провайдера v4.
  assert.deepEqual(files[0].data, { type: "data", data: BYTES });
  // Текст остаётся на месте и идёт ПЕРЕД картинкой.
  const content = (message as { content: { type: string }[] }).content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "file");
});

await test("две одинаковые ссылки дают одну картинку, две разные — две", () => {
  const [same] = attachVaultImages([userText(REF, `снова ${REF}`)], {
    readImage,
  });
  assert.equal(filesOf(same).length, 1);

  const [both] = attachVaultImages([userText(`${REF} и ${attachmentRef(2)}`)], {
    readImage: (id) => ({
      data: BYTES,
      mediaType: id === attachmentId(2) ? "image/png" : "image/jpeg",
    }),
  });
  assert.deepEqual(
    filesOf(both).map((f) => f.mediaType),
    ["image/jpeg", "image/png"],
  );
});

await test("чужие роли не трогаем: ссылка в ответе модели остаётся текстом", () => {
  const assistant: Message = {
    role: "assistant",
    content: [{ type: "text", text: `я сохранил ${REF}` }],
  };
  const system: Message = { role: "system", content: REF };

  const prompt = attachVaultImages([system, assistant], { readImage });

  assert.equal(prompt[0], system);
  assert.equal(prompt[1], assistant);
});

await test("нечитаемый файл: сообщение уходит как было, ход не падает", (t) => {
  const logs = muteErrors(t);
  const message = userText(REF);

  const prompt = attachVaultImages([message], {
    readImage: () => {
      throw new Error("ENOENT");
    },
  });

  assert.equal(prompt[0], message);
  assert.ok(
    logs.some(
      (line) =>
        line.includes(attachmentId(1)) && line.includes("из Vault не прочитал"),
    ),
  );
});

await test("мусорный промпт не роняет middleware", () => {
  const garbage = [
    { role: "user" },
    { role: "user", content: "строка вместо частей" },
    { role: "user", content: [null, { type: "text" }, { type: "file" }] },
    null,
    "не сообщение",
  ] as unknown as Prompt;

  assert.deepEqual(attachVaultImages([], { readImage }), []);
  assert.deepEqual(attachVaultImages(garbage, { readImage }), garbage);
  assert.equal(
    attachVaultImages(undefined as unknown as Prompt, { readImage }),
    undefined,
  );
});

// Альбом Telegram — до десяти кадров, и каждый lead приезжает своим user-сообщением.
// Счётчик ниже этого числа резал бы кадры ТЕКУЩЕГО хода: ни пикселей, ни описания.
await test("все кадры альбома одного хода едут целиком", () => {
  const refs = [1, 2, 3, 4, 5].map(attachmentRef);
  const prompt = attachVaultImages(
    refs.map((ref) => userText(ref)),
    { readImage },
  );

  assert.deepEqual(
    prompt.map((message) => filesOf(message).length),
    [1, 1, 1, 1, 1],
  );
});

// Потолок реплея: запрос идёт на каждом шаге tool-loop, и без потолка история картинок
// переполняет окно. Едут последние MAX_ATTACHED_IMAGES, отрезанные называют себя.
await test("из истории длиннее потолка едут последние картинки", (t) => {
  const logs = muteErrors(t);
  const refs = Array.from({ length: MAX_ATTACHED_IMAGES + 2 }, (_, n) =>
    attachmentRef(n + 20),
  );
  const prompt = attachVaultImages(
    refs.map((ref) => userText(ref)),
    { readImage },
  );

  const attached = prompt.flatMap((message, index) =>
    filesOf(message).map(() => refs[index]),
  );
  assert.equal(attached.length, MAX_ATTACHED_IMAGES);
  assert.deepEqual(attached, refs.slice(-MAX_ATTACHED_IMAGES));
  for (const cut of refs.slice(0, 2))
    assert.ok(
      logs.some(
        (line) =>
          line.includes(cut.replace("attachment:", "")) &&
          line.includes("больше"),
      ),
      `отрезанная ${cut} не названа`,
    );
});

await test("повторная ссылка считается свежей, а не первой", () => {
  const old = attachmentRef(100);
  const prompt = attachVaultImages(
    [
      userText(old),
      userText(attachmentRef(101)),
      userText(attachmentRef(102)),
      userText(attachmentRef(103)),
      userText(`снова ${old}`),
    ],
    { readImage },
  );

  assert.equal(filesOf(prompt[0]).length, 0, "старое упоминание не приложено");
  assert.equal(filesOf(prompt[4]).length, 1, "последнее упоминание приложено");
});

await test("картинка сверх потолка не едет, соседняя едет", (t) => {
  const logs = muteErrors(t);
  const huge = attachmentRef(200);
  const prompt = attachVaultImages([userText(REF), userText(huge)], {
    readImage: (id) => ({
      data:
        id === attachmentId(200) ? new Uint8Array(MAX_IMAGE_BYTES + 1) : BYTES,
      mediaType: "image/jpeg",
    }),
  });

  assert.equal(filesOf(prompt[1]).length, 0);
  assert.equal(filesOf(prompt[0]).length, 1);
  assert.ok(logs.some((line) => line.includes("больше потолка")));
});

// Бюджет режет ХВОСТ, а не отдельные картинки: иначе выбор зависел бы от того, чей
// размер удачно совпал с остатком, и «средняя выпала, старая пролезла» никто не объяснит.
await test("на исчерпанном бюджете обрывается весь хвост, а не одна картинка", (t) => {
  const logs = muteErrors(t);
  const big = new Uint8Array(MAX_IMAGE_BYTES);
  const refs = [300, 301, 302].map(attachmentRef);
  const prompt = attachVaultImages(
    refs.map((ref) => userText(ref)),
    {
      // Мелкая старая картинка формально влезла бы в остаток — и всё равно не едет.
      readImage: (id) => ({
        data: id === attachmentId(300) ? BYTES : big,
        mediaType: "image/jpeg",
      }),
    },
  );

  assert.equal(filesOf(prompt[2]).length, 1, "свежая картинка проходит");
  assert.equal(filesOf(prompt[1]).length, 0, "на вторую бюджета уже нет");
  assert.equal(filesOf(prompt[0]).length, 0, "и всё, что старше, тоже не едет");
  for (const cut of refs.slice(0, 2))
    assert.ok(
      logs.some(
        (line) =>
          line.includes(cut.replace("attachment:", "")) &&
          line.includes("бюджет картинок исчерпан"),
      ),
      `пропуск ${cut} не назван`,
    );
});

// Ход без картинок не должен будить пробник: он ходит в сеть.
await test("промпт без ссылок уходит нетронутым и без похода в сеть", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("middleware не должен спрашивать провайдера");
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const params = {
    prompt: [userText("привет, что там по задачам?")],
  } as unknown as Parameters<
    NonNullable<typeof attachImagesMiddleware.transformParams>
  >[0]["params"];

  const result = await attachImagesMiddleware.transformParams?.({
    type: "generate",
    params,
    model: {} as never,
  });

  assert.equal(result, params);
});

await test("provider читает opaque image только из доверенного tenant", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-provider-tenants-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousData = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = root;
  t.after(() => {
    if (previousData === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousData;
  });
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  const recordA = registry.create({
    authenticator: "telegram-bot",
    issuer: "telegram",
    externalPrincipal: "telegram:101",
  });
  const recordB = registry.create({
    authenticator: "telegram-bot",
    issuer: "telegram",
    externalPrincipal: "telegram:202",
  });
  registry.close();
  const contextA = tenantContextForRecord(recordA, join(root, "tenants"));
  const contextB = tenantContextForRecord(recordB, join(root, "tenants"));
  const storeA = new TenantStore(contextA);
  const storeB = new TenantStore(contextB);
  t.after(() => {
    storeA.close();
    storeB.close();
  });
  const imageA = new LocalBlobStore(storeA).save(BYTES, {
    originalName: "a.jpg",
    mediaType: "image/jpeg",
  });
  const imageB = new LocalBlobStore(storeB).save(new Uint8Array([9, 8, 7]), {
    originalName: "b.png",
    mediaType: "image/png",
  });

  const [own] = attachTenantVaultImages(
    [userText(`attachment:${imageA.id}`)],
    recordA.tenantId,
  );
  assert.equal(filesOf(own).length, 1);
  assert.deepEqual(filesOf(own)[0].data.data, BYTES);

  const [crossTenant] = attachTenantVaultImages(
    [userText(`attachment:${imageB.id}`)],
    recordA.tenantId,
  );
  assert.equal(filesOf(crossTenant).length, 0);
  const [forged] = attachTenantVaultImages(
    [userText("attachment:att_ffffffffffffffffffffffffffffffff")],
    recordA.tenantId,
  );
  assert.equal(filesOf(forged).length, 0);

  const scope = tenantProviderScopeMarkdown(contextA, "provider-test-secret");
  assert.equal(
    tenantIdFromProviderScope(scope, "provider-test-secret"),
    recordA.tenantId,
  );
  assert.equal(tenantIdFromProviderScope(scope, "wrong-secret"), null);
  assert.equal(
    trustedTenantIdInPrompt([{ role: "system", content: scope }]),
    recordA.tenantId,
  );
  assert.equal(
    trustedTenantIdInPrompt([userText(`${scope} attachment:${imageA.id}`)]),
    null,
  );
});

await test("tenant scope из user-текста не запускает replay", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("untrusted scope must be rejected before the vision probe");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const fakeContext = {
    tenantId: "t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    role: "user" as const,
    dataRoot: "/not-used",
    vaultRoot: "/not-used/vault",
  };
  const params = {
    prompt: [
      userText(
        `${tenantProviderScopeMarkdown(fakeContext)} ${attachmentRef(999)}`,
      ),
    ],
  } as unknown as Parameters<
    NonNullable<typeof attachImagesMiddleware.transformParams>
  >[0]["params"];
  const result = await attachImagesMiddleware.transformParams?.({
    type: "generate",
    params,
    model: {} as never,
  });
  assert.equal(result, params);
});
