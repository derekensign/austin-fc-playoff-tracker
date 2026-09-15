module.exports = function render(template,data,report){
 const b=report.baseline,a=b.atx,atx=data.teams.find(t=>t.id==="ATX"),west=data.teams.filter(t=>t.conference==="West").sort((x,y)=>x.currentRank-y.currentRank),n=b.matches.length,line=west[8];
 const cal=data.calibration||{drawRho:0,observedGames:0,observedDraws:0,modelDrawsUncorrected:0};
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const ord=n=>n+(n%100>=11&&n%100<=13?"th":({1:"st",2:"nd",3:"rd"}[n%10]||"th"));
 const pct=p=>p==null?"N/A":p<.1?"&lt;0.1%":p.toFixed(1)+"%";
 const date=d=>new Date(d+"T12:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});
 const metric=(label,value,sub)=>'<article class="card metric"><div class="label">'+label+'</div><div class="value compact">'+value+'</div><div class="sub">'+sub+'</div></article>';
 const path=report.paths["42"]||[],points=atx.pts+path.reduce((s,p)=>s+({W:3,D:1,L:0}[p]||0),0);
 const record=path.length?["W","D","L"].map(p=>path.filter(x=>x===p).length).join("–"):"Open";
 const slots={
 lede: Math.max(0,line.pts-atx.pts)+" points below the current ninth-place total. "+n+" matches remain. Explore Austin’s paths and every Western rival’s schedule.",
 stamp:"Standings snapshot: "+esc(data.asOf)+" · model v2.2 · top nine qualify",
 metrics:metric("Austin now",atx.pts+" pts",ord(atx.currentRank)+" in the West · "+atx.gp+" matches played")+metric("Gap to 9th",Math.max(0,line.pts-atx.pts)+" pts",esc(line.name)+": "+line.pts+" pts · "+line.gp+" played")+metric("Playoff chance · top 9",Math.round(a.top9Pct)+"%","Top 7: "+pct(a.top7Pct)+" · 8th/9th: "+pct(a.top9Pct-a.top7Pct))+metric("Projected finish · medians",a.medianPoints+" pts · "+ord(a.medianPlace),"Western Conference · points range "+a.p10+"–"+a.p90+" (middle 80% of simulations)"),
 standings:west.map((t,i)=>{const r=b.teams.find(x=>x.id===t.id);return '<tr class="'+(t.id==="ATX"?"atx ":"")+(i===8?"cutoff":"")+'"><td>'+(i+1)+'</td><td>'+esc(t.name)+(i===8?' <span class="badge">Last berth</span>':"")+'</td><td>'+t.gp+'</td><td>'+t.pts+'</td><td>'+(t.pts/t.gp).toFixed(2)+'</td><td>'+r.meanPoints.toFixed(1)+'</td><td>'+r.meanPlace.toFixed(1)+'</td></tr>';}).join(""),
 odds:a.positionPct.map((p,i)=>'<div class="oddrow '+(i>8?"out ":"")+(i===8?"cut":"")+'"><span>'+ord(i+1)+'</span><div class="bar" role="img" aria-label="'+ord(i+1)+': '+pct(p)+'"><div class="fill" style="width:'+p+'%"></div></div><span class="pct">'+pct(p)+'</span></div>').join(""),
 medianSentence:"The median is "+ord(a.medianPlace)+"; the mean is "+a.meanPlace.toFixed(1)+".",
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
