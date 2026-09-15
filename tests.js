
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
// Low-score correction: present and in range, monotone in the right direction, a no-op at zero,
// and the calibration solver actually hits its target.
assert.equal(data.version,model.VERSION,"data.json was built by a different model version");
const cal=data.calibration;assert.ok(cal&&Number.isFinite(cal.drawRho),"Missing draw calibration");
assert.ok(Math.abs(cal.modelDrawsCorrected-cal.observedDraws)<0.05,"Calibrated model does not reproduce observed draws: "+cal.modelDrawsCorrected+" vs "+cal.observedDraws);
assert.ok(cal.observedDraws>cal.modelDrawsUncorrected?cal.drawRho<0:cal.drawRho>=0,"drawRho sign disagrees with the draw shortfall");
const f0=model.rates(data,{drawRho:0})[0],fNeg=model.rates(data,{drawRho:-.1})[0],fPos=model.rates(data,{drawRho:.05})[0];
assert.equal(f0.rho,0);assert.equal(model.rates(data)[0].rho,cal.drawRho,"default rho must come from data.calibration");
const [d0,dNeg,dPos]=[f0,fNeg,fPos].map(f=>model.scoreTable(f).probs.D);
assert.ok(dNeg>d0&&d0>dPos,"negative rho must raise P(draw), positive must lower it");
for(const [hg,ag] of [[0,0],[1,1],[2,0],[0,2],[3,1]])assert.equal(model.lowScoreFactor(hg,ag,1.5,1.2,0),1,"rho 0 must leave every score untouched");
assert.equal(model.lowScoreFactor(2,2,1.5,1.2,-.2),1,"correction must only touch scores with both sides <= 1");
// Solver: synthetic leagues. A reachable target is hit exactly; unreachable ones clamp to the
// bound on the correct side (too many observed draws -> RHO_MIN, too few -> RHO_MAX).
const synthetic={teams:data.teams},forty=data.fixtures.slice(0,40),rhoMin=model.rates(data,{drawRho:-9})[0].rho,rhoMax=model.rates(data,{drawRho:9})[0].rho;
const fit=model.calibrateDrawRho(synthetic,forty.map((f,i)=>({home:f.home,away:f.away,draw:i%4===0})));
assert.ok(fit.drawRho<0&&fit.drawRho>rhoMin&&Math.abs(fit.modelDrawsCorrected-10)<0.05,"solver failed to hit 10 draws: "+JSON.stringify(fit));
assert.equal(model.calibrateDrawRho(synthetic,forty.map(f=>({home:f.home,away:f.away,draw:true}))).drawRho,rhoMin,"all-draws target must clamp to RHO_MIN");
assert.equal(model.calibrateDrawRho(synthetic,forty.map(f=>({home:f.home,away:f.away,draw:false}))).drawRho,rhoMax,"no-draws target must clamp to RHO_MAX");
// Fixed results generalise to any fixture from the home side's view; Austin-relative codes stay Austin-only.
const van=data.teams.find(t=>t.id==="VAN"),vanFixtures=data.fixtures.filter(f=>f.home==="VAN"||f.away==="VAN");
const vanWinsOut=Object.fromEntries(vanFixtures.map(f=>[f.id,f.home==="VAN"?"H":"A"]));
assert.equal(model.simulate(data,{iterations:100,fixed:vanWinsOut}).teams.find(t=>t.id==="VAN").meanPoints,van.pts+3*vanFixtures.length,"H/A fixed results must decide non-Austin fixtures");
const nonAustin=data.fixtures.find(f=>f.home!=="ATX"&&f.away!=="ATX");
assert.throws(()=>model.simulate(data,{iterations:10,fixed:{[nonAustin.id]:"W"}}),"Austin-relative result must be rejected on a non-Austin fixture");
const austinHome=data.fixtures.find(f=>f.home==="ATX"),austinAway=data.fixtures.find(f=>f.away==="ATX");
assert.equal(model.simulate(data,{iterations:100,fixed:{[austinHome.id]:"H"}}).atx.meanPoints,model.simulate(data,{iterations:100,fixed:{[austinHome.id]:"W"}}).atx.meanPoints,"H on an Austin home fixture must equal W");
assert.equal(model.simulate(data,{iterations:100,fixed:{[austinAway.id]:"A"}}).atx.meanPoints,model.simulate(data,{iterations:100,fixed:{[austinAway.id]:"W"}}).atx.meanPoints,"A on an Austin away fixture must equal W");
// Points curve partitions the simulations and agrees with the other summaries of the same run.
const run=model.simulate(data,{iterations:2000});
assert.ok(Math.abs(run.pointsCurve.reduce((s,p)=>s+p.sharePct,0)-100)<1e-9,"points curve shares must sum to 100");
assert.ok(Math.abs(run.pointsCurve.filter(p=>p.pts>=42).reduce((s,p)=>s+p.sharePct,0)-run.targets[42].reachPct)<1e-9,"points curve disagrees with the 42-point target");
assert.ok(Math.abs(run.pointsCurve.reduce((s,p)=>s+p.sharePct*p.top9Pct/100,0)-run.atx.top9Pct)<1e-6,"points curve disagrees with headline top-nine odds");
for(const p of run.pointsCurve)assert.ok(p.pts>=atx.pts&&p.pts<=atx.pts+3*remaining&&p.top7Pct<=p.top9Pct,"points curve row out of bounds "+JSON.stringify(p));
console.log("PASS: schedule, conservation, determinism, ranking, probability, recent-form, draw-calibration, fixed-result, points-curve and scenario checks.");
