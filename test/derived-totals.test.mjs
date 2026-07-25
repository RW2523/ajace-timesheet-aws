// Tier 2: server-side derivation must override client-claimed totals.
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";
const EMP="cccccccc-0000-0000-0000-000000000003";
const employee={id:EMP,email:"c@x.com",role:"employee"};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n}  ${x}`))};
await query(`insert into auth_users(id,email,password_hash,role) values($1,'c@x.com','x','employee') on conflict do nothing`,[EMP]);
await query(`insert into ts_profiles(id,email,full_name,role) values($1,'c@x.com','C','employee') on conflict do nothing`,[EMP]);

// client LIES: claims 500 total from days that really add to 24 (16 worked + 8 PTO)
const days=[{date:"2026-06-01",regular:8,overtime:0},{date:"2026-06-02",regular:8,overtime:0},{date:"2026-06-03",other:8}];
let r=await execute(employee,{table:"ts_timesheets",op:"upsert",onConflict:"user_id,year,month",single:true,
  values:{user_id:EMP,month:6,year:2026,days,questionnaire:{},validation:{},
          monthly_regular:500,monthly_overtime:500,monthly_total:500,days_worked:99}});
ok("upsert ok",!r.error,r.error||"");
ok("server ignored claimed regular 500 -> 16",Number(r.data.monthly_regular)===16,String(r.data.monthly_regular));
ok("server ignored claimed total 500 -> 24",Number(r.data.monthly_total)===24,String(r.data.monthly_total));
ok("PTO counted in total but NOT in regular",Number(r.data.monthly_regular)===16&&Number(r.data.monthly_total)===24);
ok("days_worked derived (3, not the claimed 99)",Number(r.data.days_worked)===3,String(r.data.days_worked));

r=await execute(employee,{table:"ts_employee_edits",op:"insert",single:true,
  values:{user_id:EMP,month:6,year:2026,days,questionnaire:{},validation:{},submitted:true,
          fields:{employee_name:"C",totals:{regular:999,overtime:999,total:999}}}});
ok("submission insert ok",!r.error,r.error||"");
ok("fields.totals recomputed server-side (total 24, not 999)",Number(r.data.fields.totals.total)===24,JSON.stringify(r.data.fields.totals));
ok("fields.totals regular is 16, not 999",Number(r.data.fields.totals.regular)===16,String(r.data.fields.totals.regular));
console.log(`\n${fail===0?"✅ ALL PASS":"❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end(); process.exit(fail?1:0);
