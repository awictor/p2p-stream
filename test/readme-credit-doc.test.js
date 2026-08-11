#!/usr/bin/env node
/**
 * readme-credit-doc.test.js — the README documents the auth+reward arc, not just offload
 * (iter 111, P2P-0077).
 *
 * The README is the adopter's entry point. For iters 68-109 it shipped an entire authenticated
 * credit ladder (identity -> signed -> certified -> receipted) and an ad-free entitlement, and the
 * README said nothing about any of it — a shipped, tested feature invisible in the README reads as
 * unshipped to someone evaluating "can I run a payable relay tier?". This test pins the section so
 * it cannot silently vanish OR soften into a payout promise the code does not make.
 *
 * Like security-doc.test.js it asserts CONTENT, not wording: each check accepts any phrasing that
 * still makes the point, so a genuine rewrite passes but a deletion of the substance fails.
 *
 * Usage: node test/readme-credit-doc.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(__dirname, "..", "README.md");

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

console.log("README exists and covers the credit/entitlement arc");
const T = existsSync(P) ? readFileSync(P, "utf8") : "";
checkTrue("README.md exists at repo root", existsSync(P));

console.log("\nit names the full credit ladder — the shipped tiers, in order of trust");
{
  // Every rung must be named; the ladder is the whole legibility story.
  for (const tier of ["attested", "signed", "certified", "receipted"]) {
    checkTrue(`names the '${tier}' tier`, new RegExp(tier, "i").test(T),
      "each rung of the ladder is a distinct, shipped /stats field");
  }
  // The load-bearing invariant: only receiptedBytes is payout-grade.
  checkTrue("states receipted is the only payout-grade tier",
    /receipted.{0,60}(payout|only|top|corroborat)/i.test(T)
      || /(only|payout).{0,60}receipted/i.test(T),
    "attested/signed/certified are legibility, not a reward basis");
}

console.log("\nit explains WHY authentication is needed — the forgeable-identity gap");
{
  checkTrue("names the free/forgeable-identity gap",
    /Math\.random|identities.{0,20}free|free.{0,20}ident|forge|sybil/i.test(T),
    "the reward is only honest if the upload it rewards cannot be forged");
}

console.log("\nit describes entitlement as computed from receiptedBytes ONLY");
{
  checkTrue("mentions ad-free entitlement",
    /ad-free/i.test(T) && /entitlement/i.test(T));
  checkTrue("ties entitlement to receiptedBytes only",
    /receiptedBytes[\s\S]{0,120}(only|entitlement)|entitlement[\s\S]{0,120}receiptedBytes/i.test(T),
    "entitlement must not be fed from attested/signed/certified");
  // Names the pure function / its home so the doc stays tied to shipped code.
  checkTrue("references the entitlement function or its file",
    /earnedEntitlement|entitlement\.js/i.test(T));
}

console.log("\nit states OWED-not-PAID and the collusion caveat — no false reward promise");
{
  checkTrue("states it reports OWED, not PAID",
    /owed.{0,30}(not|never).{0,10}paid|not.{0,10}paid|no payout rail|reports what is owed/i.test(T),
    "shipping a reward figure that reads as PAID on forgeable-in-collusion numbers is the headline risk");
  checkTrue("admits certified peers can still collude",
    /collu/i.test(T),
    "solo forgery is defended; a certified ring on mutual receipts is NOT — say so");
  checkTrue("points at SECURITY.md for the threat detail",
    /SECURITY\.md/i.test(T));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
