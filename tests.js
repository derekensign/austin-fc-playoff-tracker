
const assert=require("node:assert/strict");
const fs=require("node:fs");
const model=require("./model.js");
const data=JSON.parse(fs.readFileSync("./data.json","utf8"));
model.validate(data);
assert.deepEqual(model.simulate(data,{iterations:200}),model.simulate(data,{iterations:200}));
for(const f of model.rates(data)){const p=model.scoreTable(f).probs;assert.ok(Math.abs(p.W+p.D+p.L-1)<1e-9);}
for(const [hg,ag] of [[2,1],[0,0],[0,4]]){const h={pts:0,wins:0,gf:0,gd:0},a={...h};model.applyScore(h,a,hg,ag);assert.equal(h.pts+a.pts,hg===ag?2:3);assert.equal(h.gd+a.gd,0);assert.equal(h.gf,hg);assert.equal(a.gf,ag);}
assert.ok(model.compare({pts:40,wins:11,gd:-10,gf:30},{pts:40,wins:10,gd:20,gf:60})<0);
assert.ok(model.compare({pts:40,wins:10,gd:3,gf:20},{pts:40,wins:10,gd:2,gf:50})<0);
assert.throws(()=>model.validate({...data,fixtures:data.fixtures.slice(1)}));
assert.throws(()=>model.validate({...data,fixtures:[...data.fixtures,data.fixtures[0]]}));
const atx=data.teams.find(t=>t.id==="ATX"),remaining=34-atx.gp;
for(const goal of [42,45])for(const r of model.records(goal-atx.pts,remaining)){assert.equal(r.w+r.d+r.l,remaining);assert.equal(3*r.w+r.d,goal-atx.pts);}
for(const r of ["W","D","L"]){const fixed=Object.fromEntries(data.fixtures.filter(f=>[f.home,f.away].includes("ATX")).map(f=>[f.id,r]));const out=model.simulate(data,{iterations:100,fixed});assert.equal(out.atx.meanPoints,atx.pts+remaining*({W:3,D:1,L:0}[r]));}
for(const t of model.simulate(data,{iterations:200}).teams)assert.ok(Math.abs(t.positionPct.reduce((s,v)=>s+v,0)-100)<1e-9);
// Recent form: present for every club, internally consistent, and league-wide in effect.
const form=data.recentForm;assert.equal(Object.keys(form).length,data.teams.length,"Missing recent form for some clubs");
for(const t of data.teams){const r=form[t.id];
 assert.ok(r&&Number.isInteger(r.gf)&&Number.isInteger(r.ga)&&Number.isInteger(r.gp),"Bad recent form "+t.id);
 assert.ok(r.gp>0&&r.gp<=6&&r.gp<=t.gp,"Recent form sample out of range "+t.id);
 assert.ok(r.gf<=t.gf&&r.ga<=t.ga,"Recent form exceeds season totals "+t.id);}
const plainRates=model.rates(data),weightedRates=model.rates(data,{recentWeight:.2});
assert.deepEqual(model.rates(data,{recentWeight:0}).map(f=>f.lambdaHome),plainRates.map(f=>f.lambdaHome),"recentWeight 0 must be a no-op");
const movedFixtures=plainRates.filter((f,i)=>Math.abs(f.lambdaHome-weightedRates[i].lambdaHome)>1e-12).length;
// Austin plays only 34-gp of the remaining fixtures, so an Austin-only weighting
// could never move this many. This is the test that pins the league-wide behaviour.
assert.ok(movedFixtures>2*(34-data.teams.find(t=>t.id==="ATX").gp),"recentWeight is not applying league-wide: only "+movedFixtures+" fixtures moved");
console.log("PASS: schedule, conservation, determinism, ranking, probability, recent-form and scenario checks.");
