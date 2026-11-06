// S-2: private Cloudinary submissions, submission file types.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCloudinaryUrl, stripCloudinarySignature, isAllowedSubmissionFile } from "../services/accessRules.js";
import { signTarget } from "../../client/src/utils/fileLinks.js";

const BASE = "https://res.cloudinary.com/demo";

test("authenticated URLs parse, with or without the permanent signature", () => {
  assert.deepEqual(parseCloudinaryUrl(`${BASE}/image/authenticated/v17/achievion/o/submissions/AUDIT-S2_ab.pdf`),
    { cloud: "demo", resourceType: "image", publicId: "achievion/o/submissions/AUDIT-S2_ab", format: "pdf" });
  assert.deepEqual(parseCloudinaryUrl(`${BASE}/raw/authenticated/s--Ab_1-x--/v17/a/b.docx`),
    { cloud: "demo", resourceType: "raw", publicId: "a/b.docx", format: undefined }, "raw: the extension is part of the id");
  assert.equal(parseCloudinaryUrl(`${BASE}/image/authenticated/v1/a.b/c.pdf`).publicId, "a.b/c");
});

test("anything else is not an authenticated Cloudinary file", () => {
  for (const bad of [`${BASE}/image/upload/v17/a.pdf`, `${BASE}/image/private/v17/a.pdf`, "https://evil.com/demo/image/authenticated/v1/a.pdf", `http://res.cloudinary.com/demo/image/authenticated/v1/a.pdf`, `${BASE}/image/authenticated/v1/../a.pdf`, `${BASE}/image/authenticated/v1/a.pdf?x=1`, "/uploads/submissions/a.pdf", "", null, [`${BASE}/image/authenticated/v1/a.pdf`]])
    assert.equal(parseCloudinaryUrl(bad), null, String(bad));
});

test("the permanent signature never gets stored", () => {
  assert.equal(stripCloudinarySignature(`${BASE}/image/authenticated/s--O8VAmaRc--/v17/a.pdf`), `${BASE}/image/authenticated/v17/a.pdf`);
  assert.equal(stripCloudinarySignature(`${BASE}/image/authenticated/v17/a.pdf`), `${BASE}/image/authenticated/v17/a.pdf`);
  assert.equal(stripCloudinarySignature("/uploads/submissions/a.pdf"), "/uploads/submissions/a.pdf");
});

test("submission files: the Cloudinary list everywhere, by extension", () => {
  for (const ok of ["a.pdf", "A.PDF", "a.jpg", "a.jpeg", "a.png", "a.zip", "a.docx", "a.xlsx", "a.txt", "a.md", "my.final.pdf"]) assert.equal(isAllowedSubmissionFile(ok), true, ok);
  for (const bad of ["a.html", "a.htm", "a.svg", "a.js", "a.exe", "a.pdf.html", "noext", "", null, ".pdf.exe"]) assert.equal(isAllowedSubmissionFile(bad), false, String(bad));
});

test("client: which links go through the sign call", () => {
  const api = "http://localhost:3001";
  assert.equal(signTarget("/uploads/submissions/a.pdf", api), "/uploads/submissions/a.pdf");
  assert.equal(signTarget(`${api}/uploads/attachments/a.pdf`, api), "/uploads/attachments/a.pdf");
  assert.equal(signTarget(`${BASE}/image/authenticated/v1/a.pdf`, api), `${BASE}/image/authenticated/v1/a.pdf`);
  for (const pass of [`${BASE}/image/upload/v1/a.pdf`, "https://github.com/x/y", "https://www.figma.com/file/z", "", undefined]) assert.equal(signTarget(pass, api), null, String(pass));
});
