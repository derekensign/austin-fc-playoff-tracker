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
{id:"recent",label:"20% weight on every club’s last six",config:{recentWeight:.2}},
{id:"shrink4",label:"Less regression to league average",config:{priorGames:4}},
{id:"shrink16",label:"More regression to league average",config:{priorGames:16}},
{id:"homeLow",label:"Smaller home advantage",config:{homeLog:.08}},
{id:"homeHigh",label:"Larger home advantage",config:{homeLog:.18}}];
const sensitivity=variants.map(v=>{const r=model.simulate(data,{iterations,seed,...v.config});return {id:v.id,label:v.label,atx:r.atx,config:r.config};});
const old=JSON.parse(read("report.json"));
const start=data.teams.find(t=>t.id==="ATX").pts;
const paths=Object.fromEntries([42,45].map(k=>[k,targetPath(baseline.matches,start,k)]));
const report={asOf:data.asOf,baseline,sensitivity,paths,explanation:old.explanation};
const html=render(read("template.html"),data,report);
if(html.includes("{{"))throw Error("Unfilled page template");
write("report.json",JSON.stringify(report,null,2));write("index.html",html);
const audit=JSON.parse(read("audit.json"));
audit.latestRefresh={asOf:data.asOf,iterations,seed,validation:"passed",tieAudit:baseline.unresolved};
write("audit.json",JSON.stringify(audit,null,2));
console.log("Forecast regenerated:",data.asOf,baseline.atx);
