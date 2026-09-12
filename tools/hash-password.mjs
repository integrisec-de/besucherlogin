#!/usr/bin/env node
// Erzeugt den Passwort-Hash fuer einen Benutzer-Datensatz.
//
// Nötig für den Cloudflare-Pages-Betrieb: dort legt sich kein Admin-Benutzer
// an (das uebernimmt server.mjs, die nur unter Node laeuft). Der erste
// Benutzer muss von Hand in AUTH_KV geschrieben werden.
//
//   node tools/hash-password.mjs                 # fragt das Passwort ab
//   node tools/hash-password.mjs "MeinPasswort"  # Achtung: landet in der Shell-History
//   node tools/hash-password.mjs --user empfang  # anderer Benutzername
//
// Ausgegeben werden der pbkdf2-String und ein fertiger JSON-Datensatz zum
// Einfuegen unter dem Schluessel  user:<name>.
//
// Die Hash-Funktion wird aus dem Anwendungscode importiert - damit kann das
// Format hier nicht vom Login abweichen.

import { hashPassword } from "../functions/[[path]].js";
import { createInterface } from "node:readline/promises";

const argv = process.argv.slice(2);
let username = "admin";
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--user" || argv[i] === "-u") { username = argv[++i] || username; }
  else if (argv[i] === "--help" || argv[i] === "-h") { help(); process.exit(0); }
  else rest.push(argv[i]);
}

function help() {
  console.log(`
Aufruf:
  node tools/hash-password.mjs [Passwort] [--user NAME]

Ohne Passwort-Argument wird interaktiv gefragt (empfohlen - so landet das
Passwort nicht in der Shell-History).
`.trim());
}

let password = rest[0];
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  password = await rl.question("Passwort: ");
  rl.close();
} else {
  console.error("Hinweis: Das Passwort stand als Argument in der Kommandozeile und");
  console.error("landet damit in der Shell-History. Ohne Argument wird es abgefragt.\n");
}

password = String(password);
if (!password) { console.error("Fehler: leeres Passwort."); process.exit(1); }
if (password.length < 8) {
  console.error(`Warnung: nur ${password.length} Zeichen. Empfohlen sind mindestens 12.\n`);
}

const passwordHash = await hashPassword(password);
const record = {
  username,
  passwordHash,
  role: "admin",
  disabled: false,
  createdAt: Date.now()
};

console.log("Hash:");
console.log(passwordHash);
console.log("");
console.log(`KV-Schluessel:  user:${username}`);
console.log("KV-Wert:");
console.log(JSON.stringify(record, null, 2));
