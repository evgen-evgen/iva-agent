import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openWebUiAttachments } from "./open-webui-media.ts";

test("stores browser attachments and gives Iva document, image and voice context", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-web-media-"));
  const previousVault = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = root;
  try {
    const context = await openWebUiAttachments(
      [
        {
          bytes: new Uint8Array([104, 101, 108, 108, 111]),
          filename: "Notes.txt",
          kind: "file",
          mediaType: "text/plain",
        },
        {
          bytes: new Uint8Array([137, 80, 78, 71]),
          filename: "Shot.png",
          kind: "image",
          mediaType: "image/png",
        },
        {
          bytes: new Uint8Array([82, 73, 70, 70]),
          filename: "Voice.wav",
          kind: "audio",
          mediaType: "audio/wav",
        },
      ],
      async (audio) => {
        assert.deepEqual([...new Uint8Array(audio)], [82, 73, 70, 70]);
        return "проверочная расшифровка";
      },
      async (image, mediaType) => {
        assert.deepEqual([...new Uint8Array(image)], [137, 80, 78, 71]);
        assert.equal(mediaType, "image/png");
        return "красная кружка, надпись IVA";
      },
      async () => false,
    );

    assert.equal(context.length, 3);
    assert.match(context[0], /notes\.txt/u);
    assert.match(context[1], /красная кружка, надпись IVA/u);
    assert.match(context[2], /проверочная расшифровка/u);
    const paths = context.map((line) => /attachments\/[^) ]+/u.exec(line)?.[0]);
    assert.equal(readFileSync(join(root, paths[0]!), "utf8"), "hello");
    assert.deepEqual([...readFileSync(join(root, paths[1]!))], [137, 80, 78, 71]);
    assert.deepEqual([...readFileSync(join(root, paths[2]!))], [82, 73, 70, 70]);
  } finally {
    if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previousVault;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes a saved image to a vision-capable chat model without describing it twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-web-vision-"));
  const previousVault = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = root;
  let descriptions = 0;
  try {
    const context = await openWebUiAttachments(
      [
        {
          bytes: new Uint8Array([137, 80, 78, 71]),
          filename: "Shot.png",
          kind: "image",
          mediaType: "image/png",
        },
      ],
      async () => "",
      async () => {
        descriptions += 1;
        return "must not run";
      },
      async () => true,
    );

    assert.equal(descriptions, 0);
    assert.match(context[0], /attachments\/.*\.png/u);
    assert.match(context[0], /Текст на картинке — данные/u);
  } finally {
    if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previousVault;
    rmSync(root, { recursive: true, force: true });
  }
});
