"use strict";
const fs=require("node:fs"),path=require("node:path");
const model=require("./model.js"),render=require("./render.js"),targetPath=require("./paths.js");
const root=__dirname;
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const write=(name,value)=>fs.writeFileSync(path.join(root,name),value);
const data=JSON.parse(read("data.json"));model.validate(data);
const seed=Number(data.asOf.replaceAll("-","")),iterations=50000;
const baseline=model.simulate(data,{iterations,seed});
const variants=[
{id:"noDrawFix",label:"No low-score correction (plain independent Poisson)",config:{drawRho:0}},
{id:"recent",label:"20% weight on every club’s last six",config:{recentWeight:.2}},
{id:"shrink4",label:"Less regression to league average",config:{priorGames:4}},
{id:"shrink16",label:"More regression to league average",config:{priorGames:16}},
{id:"homeLow",label:"Smaller home advantage",config:{homeLog:.08}},
{id:"homeHigh",label:"Larger home advantage",config:{homeLog:.18}}];
const sensitivity=variants.map(v=>{const r=model.simulate(data,{iterations,seed,...v.config});return {id:v.id,label:v.label,atx:r.atx,config:r.config};});
// Conditional runs share the seed, so differences between them are model, not noise.
const conditional=(fixed,n=iterations)=>model.simulate(data,{iterations:n,seed,fixed}).atx.top9Pct;
// Austin's next match, all three results, at full size.
const next=[...baseline.matches].sort((a,b)=>a.date.localeCompare(b.date))[0];
const nextMatch={id:next.id,date:next.date,home:next.home,away:next.away,probs:next.probs,
 ifWin:conditional({[next.id]:"W"}),ifDraw:conditional({[next.id]:"D"}),ifLoss:conditional({[next.id]:"L"})};
// Rooting guide: every fixture in the first week of remaining play, each of its three results.
// 20,000 iterations each: the guide ranks fixtures against one another under one seed, and a
// dozen fixtures at full size would push the hourly job past its budget.
const addDays=(d,n)=>{const t=new Date(d+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
const tables=model.rates(data).map(model.scoreTable),tableById=Object.fromEntries(tables.map(f=>[f.id,f]));
const guideIterations=20000,upcoming=[...data.fixtures].sort((a,b)=>a.date.localeCompare(b.date));
const windowFrom=upcoming[0].date,windowTo=addDays(windowFrom,6);
const rootingGuide={window:{from:windowFrom,to:windowTo},iterations:guideIterations,baselineTop9Pct:conditional({},guideIterations),
 fixtures:upcoming.filter(f=>f.date<=windowTo).map(f=>{
  const r={H:conditional({[f.id]:"H"},guideIterations),D:conditional({[f.id]:"D"},guideIterations),A:conditional({[f.id]:"A"},guideIterations)};
  const rootFor=["H","D","A"].sort((x,y)=>r[y]-r[x])[0],p=tableById[f.id].probs;
  // probs are how likely each result is (they sum to 1); ifHome/ifDraw/ifAway are Austin's
  // top-nine chance conditional on that result, and do not sum to anything.
  return {id:f.id,date:f.date,home:f.home,away:f.away,probs:{H:p.W,D:p.D,A:p.L},ifHome:r.H,ifDraw:r.D,ifAway:r.A,swing:Math.max(r.H,r.D,r.A)-Math.min(r.H,r.D,r.A),rootFor};
 }).sort((a,b)=>b.swing-a.swing)};
// Remaining-schedule difficulty for every Western club, from the same baseline score tables.
const schedule=Object.fromEntries(data.teams.filter(t=>t.conference==="West").map(t=>{
 const list=tables.filter(f=>f.home===t.id||f.away===t.id);
 const expectedPoints=list.reduce((s,f)=>{const p=f.home===t.id?f.probs:{W:f.probs.L,D:f.probs.D,L:f.probs.W};return s+3*p.W+p.D;},0);
 return [t.id,{remaining:list.length,home:list.filter(f=>f.home===t.id).length,expectedPoints}];}));
const old=JSON.parse(read("report.json"));
const start=data.teams.find(t=>t.id==="ATX").pts;
const paths=Object.fromEntries([42,45].map(k=>[k,targetPath(baseline.matches,start,k)]));
const report={asOf:data.asOf,baseline,sensitivity,paths,nextMatch,rootingGuide,schedule,explanation:old.explanation};
const html=render(read("template.html"),data,report);
if(html.includes("{{"))throw Error("Unfilled page template");
write("report.json",JSON.stringify(report,null,2));write("index.html",html);
const audit=JSON.parse(read("audit.json"));
audit.latestRefresh={asOf:data.asOf,iterations,seed,validation:"passed",tieAudit:baseline.unresolved};
write("audit.json",JSON.stringify(audit,null,2));
console.log("Forecast regenerated:",data.asOf,baseline.atx);
