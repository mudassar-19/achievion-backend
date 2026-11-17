import { readFileSync } from "node:fs";
for (const l of readFileSync("../.env.test","utf8").split("\n")) { const i=l.indexOf("="); if(i>0&&!l.startsWith("#")&&!process.env[l.slice(0,i)]) process.env[l.slice(0,i)]=l.slice(i+1).trim(); }
import { loginAs } from "./tests/helpers/login.mjs";
const API="http://localhost:5071";
const d = await loginAs(API,"T7843_DIRECTOR",process.env.T7843_ORG_CODE);
const r = await fetch(API+"/api/communities",{headers:{authorization:`Bearer ${d.token}`}}).then(r=>r.json());
for (const c of r) console.log(c.name,"|",c.type,"|",c.groups.map(g=>g.name).join(","));
