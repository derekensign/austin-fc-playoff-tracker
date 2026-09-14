
(async function(){
"use strict";
const $=id=>document.getElementById(id);
const resultEl=$("scenarioResult"), run=$("runScenario");
const controls=["preset42","preset45","presetOpen"];
let worker=null,revision=0,data,report;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ordinal=n=>n+(n%100>=11&&n%100<=13?"th":({1:"st",2:"nd",3:"rd"}[n%10]||"th"));
const date=d=>new Date(d+"T12:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});
const pct=v=>v<.1?"<0.1%":v.toFixed(1)+"%";
function cancel(){revision++;if(worker){worker.terminate();worker=null;}run.disabled=false;resultEl.textContent="Results changed. Run the scenario to refresh its odds.";}
function fixed(){const f={};document.querySelectorAll('.pick button[aria-pressed="true"]').forEach(b=>{if(b.dataset.result!=="?")f[b.dataset.id]=b.dataset.result;});return f;}
function updateTotal(){
const picks=Object.values(fixed()), w=picks.filter(p=>p==="W").length,d=picks.filter(p=>p==="D").length,l=picks.filter(p=>p==="L").length;
const remaining=data.fixtures.filter(f=>f.home==="ATX"||f.away==="ATX").length,open=remaining-picks.length;
const start=data.teams.find(t=>t.id==="ATX").pts,points=start+3*w+d;
$("scenarioTotal").textContent=open?points+"–"+(points+3*open)+" points possible":points+" points";
$("scenarioRecord").textContent=w+" wins · "+d+" draws · "+l+" losses"+(open?" · "+open+" open":"");
}
function preset(picks){document.querySelectorAll(".game").forEach((row,i)=>row.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.result===(picks[i]||"?")))));cancel();updateTotal();}
run.disabled=true;controls.forEach(id=>$(id).disabled=true);
try{
const responses=await Promise.all([fetch("/data.json",{cache:"no-cache"}),fetch("/report.json",{cache:"no-cache"})]);
if(responses.some(r=>!r.ok))throw Error("Could not load forecast data");
[data,report]=await Promise.all(responses.map(r=>r.json()));VerdeModel.validate(data);
if(data.asOf!==report.asOf||data.version!==report.baseline.version)throw Error("Data and report versions differ");
}catch(err){resultEl.textContent="Interactive data could not load: "+err.message+". The dated forecast above is still readable.";return;}
const teams=Object.fromEntries(data.teams.map(t=>[t.id,t]));
const matches=VerdeModel.rates(data).map(VerdeModel.scoreTable);
function renderSchedule(){
 const id=$("teamSelect").value,team=teams[id];
 const fs=matches.filter(f=>f.home===id||f.away===id),home=fs.filter(f=>f.home===id).length;
 let points=0;
 $("scheduleBody").innerHTML=fs.map(f=>{
 const isHome=f.home===id,p=isHome?f.probs:{W:f.probs.L,D:f.probs.D,L:f.probs.W},xp=3*p.W+p.D;points+=xp;
 return "<tr><td>"+date(f.date)+"</td><td>"+(isHome?"vs ":"@ ")+esc(teams[isHome?f.away:f.home].name)+"</td><td>"+pct(p.W*100)+"</td><td>"+pct(p.D*100)+"</td><td>"+pct(p.L*100)+"</td><td>"+xp.toFixed(2)+"</td></tr>";
 }).join("");
 const forecast=report.baseline.teams.find(t=>t.id===id);
 $("scheduleSummary").textContent=team.name+": "+fs.length+" left · "+home+" home / "+(fs.length-home)+" away · "+points.toFixed(1)+" expected additional points · "+(team.pts+points).toFixed(1)+" expected final points · "+pct(forecast.top9Pct)+" top-nine chance.";
}
$("teamSelect").addEventListener("change",renderSchedule);renderSchedule();
document.querySelectorAll(".pick button").forEach(b=>b.addEventListener("click",()=>{
 b.parentElement.querySelectorAll("button").forEach(s=>s.setAttribute("aria-pressed",String(s===b)));cancel();updateTotal();
}));
$("preset42").onclick=()=>preset(report.paths["42"]||[]);
$("preset45").onclick=()=>preset(report.paths["45"]||[]);
$("presetOpen").onclick=()=>preset([]);
run.onclick=()=>{
 if(worker)worker.terminate();
 const thisRevision=revision,chosen=fixed();run.disabled=true;resultEl.textContent="Simulating 20,000 seasons with your chosen Austin results…";
 try{worker=new Worker("/worker.js");
 worker.onmessage=e=>{
 if(thisRevision!==revision)return;
 run.disabled=false;worker.terminate();worker=null;
 if(e.data.error){resultEl.textContent="Simulation error: "+e.data.error;return;}
 const r=e.data.result,atx=r.atx;
 resultEl.textContent="Your scenario: "+atx.medianPoints+" points · "+ordinal(atx.medianPlace)+" in the West (medians). Top-nine chance: "+pct(atx.top9Pct)+". Top-seven chance: "+pct(atx.top7Pct)+". "+
 "This is conditional on your selected results. The baseline forecast above is unchanged.";
 };
 worker.onerror=()=>{run.disabled=false;if(worker)worker.terminate();worker=null;resultEl.textContent="The scenario could not run in this browser. The points calculator still works.";};
 worker.postMessage({data,config:{iterations:20000,seed:20260914,fixed:chosen}});
 }catch(err){run.disabled=false;resultEl.textContent="This browser cannot run the scenario: "+err.message;}
};
run.disabled=false;controls.forEach(id=>$(id).disabled=false);updateTotal();
})();
