module.exports = function render(template,data,report){
 const b=report.baseline,a=b.atx,atx=data.teams.find(t=>t.id==="ATX"),west=data.teams.filter(t=>t.conference==="West").sort((x,y)=>x.currentRank-y.currentRank),n=b.matches.length,line=west[8];
 const cal=data.calibration||{drawRho:0,observedGames:0,observedDraws:0,modelDrawsUncorrected:0};
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const ord=n=>n+(n%100>=11&&n%100<=13?"th":({1:"st",2:"nd",3:"rd"}[n%10]||"th"));
 const pct=p=>p==null?"N/A":p<.1?"&lt;0.1%":p.toFixed(1)+"%";
 const date=d=>new Date(d+"T12:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});
 const name=id=>data.teams.find(t=>t.id===id).name,signed=v=>(v>0?"+":"")+v;
 const metric=(label,value,sub)=>'<article class="card metric"><div class="label">'+label+'</div><div class="value compact">'+value+'</div><div class="sub">'+sub+'</div></article>';
 const path=report.paths["42"]||[],points=atx.pts+path.reduce((s,p)=>s+({W:3,D:1,L:0}[p]||0),0);
 const record=path.length?["W","D","L"].map(p=>path.filter(x=>x===p).length).join("–"):"Open";
 const fixturesOf=id=>data.fixtures.filter(f=>f.home===id||f.away===id).sort((x,y)=>x.date.localeCompare(y.date));
 // Deterministic magic/tragic numbers for Austin. Both assume the club currently holding the
 // relevant ninth slot stays there; anyone overtaking them only moves the number the same way.
 const magic=(()=>{
  const max=atx.pts+3*n,rivals=west.filter(t=>t.id!=="ATX");
  const ninthNow=[...rivals].sort((x,y)=>y.pts-x.pts)[8];
  const ceilings=rivals.map(t=>({id:t.id,max:t.pts+3*fixturesOf(t.id).length})).sort((x,y)=>y.max-x.max),ninthCeiling=ceilings[8];
  const tragic=max-ninthNow.pts+1,magicNumber=ninthCeiling.max-atx.pts+1;
  const out=rivals.filter(t=>t.pts>max).length>=9,inn=rivals.filter(t=>t.pts+3*fixturesOf(t.id).length>=atx.pts).length<9;
  return '<p><strong>Maximum:</strong> '+max+' points — '+atx.pts+' banked plus '+n+' matches to play.</p>'+
   '<p><strong>Tragic number: '+(out?"0 — eliminated":tragic)+'</strong><br><span class="small">Austin is out once the ninth-best rival total passes '+max+'. That total is '+ninthNow.pts+' ('+esc(ninthNow.name)+') today. Every point that club gains, and every point Austin fails to take from its remaining '+(3*n)+', brings the number down by one.</span></p>'+
   '<p><strong>Magic number: '+(inn?"0 — clinched":magicNumber)+'</strong><br><span class="small">Austin is in once its total passes the ninth-highest rival ceiling, currently '+ninthCeiling.max+' ('+esc(name(ninthCeiling.id))+'). Every point Austin gains, and every point that club drops from its ceiling, brings the number down by one. Austin can supply at most '+(3*n)+' of them itself.</span></p>'+
   '<p class="small">Points ties go to wins, then goal difference, and are not counted here.</p>';})();
 const g=report.rootingGuide,m=report.nextMatch;
 const slots={
 lede: Math.max(0,line.pts-atx.pts)+" points below the current ninth-place total. "+n+" matches remain. Explore Austin’s paths and every Western rival’s schedule.",
 stamp:"Standings snapshot: "+esc(data.asOf)+" · model v2.3 · top nine qualify",
 metrics:metric("Austin now",atx.pts+" pts",ord(atx.currentRank)+" in the West · "+atx.gp+" matches played")+metric("Gap to 9th",Math.max(0,line.pts-atx.pts)+" pts",esc(line.name)+": "+line.pts+" pts · "+line.gp+" played")+metric("Playoff chance · top 9",Math.round(a.top9Pct)+"%","Top 7: "+pct(a.top7Pct)+" · 8th/9th: "+pct(a.top9Pct-a.top7Pct))+metric("Projected finish · medians",a.medianPoints+" pts · "+ord(a.medianPlace),"Western Conference · points range "+a.p10+"–"+a.p90+" (middle 80% of simulations)"),
 standings:west.map((t,i)=>{const r=b.teams.find(x=>x.id===t.id),s=report.schedule[t.id],form=data.recentForm[t.id],nextThree=fixturesOf(t.id).slice(0,3);
  const info='<div class="clubinfo"><span>Last six: '+esc(form?form.description:"n/a")+'</span><span>Next: '+(nextThree.length?nextThree.map(f=>date(f.date)+" "+(f.home===t.id?"vs ":"@ ")+esc(name(f.home===t.id?f.away:f.home))).join(", "):"season complete")+'</span></div>';
  return '<tr class="'+(t.id==="ATX"?"atx ":"")+(i===8?"cutoff":"")+'"><td>'+(i+1)+'</td><td><details class="club"><summary>'+esc(t.name)+(i===8?' <span class="badge">Last berth</span>':"")+'</summary>'+info+'</details></td><td>'+t.gp+'</td><td>'+t.pts+'</td><td>'+signed(t.gf-t.ga)+'</td><td>'+t.gf+'</td><td>'+s.remaining+' · '+s.expectedPoints.toFixed(1)+'</td><td>'+r.meanPoints.toFixed(1)+'</td><td>'+pct(r.top9Pct)+'</td></tr>';}).join(""),
 odds:a.positionPct.map((p,i)=>'<div class="oddrow '+(i>8?"out ":"")+(i===8?"cut":"")+'"><span>'+ord(i+1)+'</span><div class="bar" role="img" aria-label="'+ord(i+1)+': '+pct(p)+'"><div class="fill" style="width:'+p+'%"></div></div><span class="pct">'+pct(p)+'</span></div>').join(""),
 medianSentence:"The median is "+ord(a.medianPlace)+"; the mean is "+a.meanPlace.toFixed(1)+".",
 heatmap:(()=>{const rows=[...b.teams].sort((x,y)=>y.top9Pct-x.top9Pct||x.meanPlace-y.meanPlace);
  return '<table class="heat"><thead><tr><th scope="col">Club</th>'+rows[0].positionPct.map((_,i)=>'<th scope="col"'+(i===8?' class="cutcol"':"")+'>'+(i+1)+'</th>').join("")+'<th scope="col">Top 9</th></tr></thead><tbody>'+
   rows.map(r=>'<tr'+(r.id==="ATX"?' class="atx"':"")+'><td>'+esc(name(r.id))+'</td>'+r.positionPct.map((p,i)=>'<td class="cell'+(p>=50?" hi":"")+(i===8?" cutcol":"")+'"'+(p>=.1?' style="background:rgba(50,187,101,'+(0.06+0.94*p/100).toFixed(3)+')"':"")+' title="'+esc(name(r.id))+' '+ord(i+1)+': '+pct(p)+'">'+(p>=1?Math.round(p):p>=.1?"·":"")+'</td>').join("")+'<td><strong>'+pct(r.top9Pct)+'</strong></td></tr>').join("")+'</tbody></table>';})(),
 pointsCurve:b.pointsCurve.filter(p=>p.sharePct>=.1).map(p=>'<tr'+(p.pts===b.cutoff.median?' class="cutoff"':"")+'><td>'+p.pts+'</td><td>'+pct(p.sharePct)+'</td><td>'+pct(p.top9Pct)+'</td><td>'+pct(p.top7Pct)+'</td></tr>').join(""),
 curveSentence:(()=>{const even=b.pointsCurve.find(p=>p.top9Pct>=50&&p.sharePct>=.1),safe=b.pointsCurve.find(p=>p.top9Pct>=90&&p.sharePct>=.1);
  return "Austin’s first total with better-than-even playoff odds is <strong>"+(even?even.pts+" points ("+pct(even.top9Pct)+")":"out of reach")+"</strong>"+(safe?"; the first that gets in nine times out of ten is <strong>"+safe.pts+"</strong>":"")+". Gold line: the median ninth-place total, "+b.cutoff.median+".";})(),
 nextMatch:(()=>{const home=m.home==="ATX",opp=name(home?m.away:m.home);
  return "Next up: "+(home?"vs ":"@ ")+esc(opp)+", "+date(m.date)+". Win and Austin’s top-nine chance goes to <strong>"+pct(m.ifWin)+"</strong>; draw, <strong>"+pct(m.ifDraw)+"</strong>; lose, <strong>"+pct(m.ifLoss)+"</strong> (baseline "+pct(a.top9Pct)+"). The model rates that match "+pct(m.probs.W*100)+" / "+pct(m.probs.D*100)+" / "+pct(m.probs.L*100)+" win / draw / loss.";})(),
 // Below half a point of swing the three cells are within run-to-run noise at 20k iterations,
 // so naming a side to root for would be reading tea leaves.
 rootingGuide:g.fixtures.map(f=>{const hn=name(f.home),an=name(f.away),matters=f.swing>=.5,root=!matters?"No effect":f.rootFor==="D"?"A draw":f.rootFor==="H"?hn:an;
  const cell=(v,k)=>'<td'+(matters&&k===f.rootFor?' class="root"':"")+'>'+pct(v)+'</td>';
  return '<tr'+([f.home,f.away].includes("ATX")?' class="atx"':"")+'><td>'+date(f.date)+'</td><td>'+esc(hn)+' v '+esc(an)+'</td>'+cell(f.ifHome,"H")+cell(f.ifDraw,"D")+cell(f.ifAway,"A")+'<td>'+f.swing.toFixed(1)+' pp</td><td><strong>'+esc(root)+'</strong></td></tr>';}).join(""),
 guideWindow:date(g.window.from)+"–"+date(g.window.to),guideBaseline:pct(g.baselineTop9Pct),guideIterations:g.iterations.toLocaleString("en-US"),guideCount:g.fixtures.length,
 magic,
 path:b.matches.map((f,i)=>'<div class="game"><div class="date">'+date(f.date)+'</div><div class="opp">'+(f.home==="ATX"?"vs ":"@ ")+esc(data.teams.find(t=>t.id===(f.home==="ATX"?f.away:f.home)).name)+'</div><div class="pick">'+["W","D","L","?"].map(p=>'<button type="button" data-id="'+esc(f.id)+'" data-result="'+p+'" aria-pressed="'+(p===(path[i]||"?"))+'" aria-label="'+date(f.date)+' '+({W:"Austin win",D:"Draw",L:"Austin loss","?":"Let model decide"}[p])+'">'+p+'</button>').join("")+'</div></div>').join(""),
 pathPoints:path.length?points+" points":atx.pts+"–"+(atx.pts+3*n)+" points possible",pathRecord:record+" (W–D–L)",
 targets:'<article class="card side"><h2>The targets</h2><div class="tablewrap"><table><thead><tr><th>Finish</th><th>Needed</th><th>PPG</th><th>Example W–D–L</th></tr></thead><tbody>'+[42,45].map(k=>{const p=report.paths[k],needed=Math.max(0,k-atx.pts);return "<tr><td>"+k+" pts</td><td>"+needed+" from "+n+"</td><td>"+(n?(needed/n).toFixed(2):needed===0?"Achieved":"Unavailable")+"</td><td>"+(p?["W","D","L"].map(r=>p.filter(x=>x===r).length).join("–"):"No exact path")+"</td></tr>";}).join("")+'</tbody></table></div><p class="callout">Neither target guarantees qualification. Ninth finishes on a median of <strong>'+b.cutoff.median+' points</strong>, with a middle-80% range of '+b.cutoff.p10+'–'+b.cutoff.p90+'.</p>'+[42,45].map(k=>'<p class="small">Austin reaches at least '+k+' in '+pct(b.targets[k].reachPct)+' of simulations. Among those simulations, it makes the top nine '+pct(b.targets[k].top9GivenAtLeastTargetPct)+' of the time. This includes higher point totals, not just exactly '+k+'.</p>').join("")+'</article>',
 teamOptions:west.map(t=>'<option value="'+esc(t.id)+'" '+(t.id==="ATX"?"selected":"")+'>'+esc(t.name)+'</option>').join(""),
 sensitivity:[{label:"Baseline · season goals, eight-game regression, assumed home advantage, calibrated draw correction",atx:a},...report.sensitivity].map(r=>"<tr><td>"+esc(r.label)+"</td><td>"+pct(r.atx.top9Pct)+"</td><td>"+r.atx.meanPoints.toFixed(1)+"</td></tr>").join(""),
 fixtureCount:data.fixtures.length,tiePct:b.unresolved.austinAnyTiePct.toFixed(3),tieBounds:b.unresolved.top9LowerPct.toFixed(2)+"–"+b.unresolved.top9UpperPct.toFixed(2),
 recentGF:data.recentForm.ATX.gf,recentGA:data.recentForm.ATX.ga,recentClubs:Object.keys(data.recentForm).length,medianPoints:a.medianPoints,medianPlace:ord(a.medianPlace),explanation:esc(report.explanation),date:esc(data.asOf),
 drawRho:cal.drawRho.toFixed(3),seasonGames:cal.observedGames,seasonDraws:cal.observedDraws,seasonDrawPct:(100*cal.observedDraws/cal.observedGames).toFixed(1),modelDrawsUncorrected:Math.round(cal.modelDrawsUncorrected)
 };
 return template.replace(/\{\{(\w+)\}\}/g,(_,k)=>{if(!(k in slots))throw Error("Missing slot "+k);return slots[k];});
};
