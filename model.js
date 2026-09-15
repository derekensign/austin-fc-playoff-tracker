const VerdeModel = (function createModel(){
  const VERSION="2.3.0";
  // Dixon-Coles rho is bounded so every low-score adjustment factor stays positive
  // for any plausible goal rate (1+lambda*rho > 0 needs rho > -1/lambda).
  const RHO_MIN=-0.25, RHO_MAX=0.1;
  function assert(ok,msg){if(!ok)throw Error(msg);}
  function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};}
  function validate(data){
    const {teams,fixtures}=data;const by=Object.fromEntries(teams.map(t=>[t.id,t]));
    assert(teams.length===30&&new Set(teams.map(t=>t.id)).size===30,"Expected 30 unique MLS teams");
    const west=teams.filter(t=>t.conference==="West");assert(west.length===15,"Expected 15 Western teams");
    for(const t of teams){for(const k of ["gp","wins","draws","losses","gf","ga","pts"])assert(Number.isInteger(t[k])&&t[k]>=0,"Invalid "+t.id+" "+k);
      assert(t.gp===t.wins+t.draws+t.losses,"Record mismatch "+t.id);assert(t.pts===t.wins*3+t.draws,"Points mismatch "+t.id);}
    assert(teams.reduce((s,t)=>s+t.gf-t.ga,0)===0,"League GF and GA do not balance");
    assert(teams.reduce((s,t)=>s+t.wins-t.losses,0)===0,"League wins and losses do not balance");
    const seen=new Set(),pairs=new Set(),days=new Set();
    for(const f of fixtures){assert(by[f.home]&&by[f.away]&&f.home!==f.away,"Unknown/self opponent");
      assert(f.id===f.date+":"+f.home+":"+f.away,"Invalid fixture ID");
      assert(f.date>data.asOf&&f.date<="2026-11-07","Fixture outside run-in");
      assert(!seen.has(f.id),"Duplicate fixture");seen.add(f.id);
      assert(!pairs.has(f.home+":"+f.away),"Duplicate home-away pair");pairs.add(f.home+":"+f.away);
      for(const id of [f.home,f.away]){assert(!days.has(f.date+":"+id),"Two matches same day "+id);days.add(f.date+":"+id);}
      if(by[f.home].conference==="West"&&by[f.away].conference==="West")assert(f.listedBy.includes(f.home)&&f.listedBy.includes(f.away),"Missing reciprocal listing "+f.id);
    }
    for(const t of west)assert(t.gp+fixtures.filter(f=>f.home===t.id||f.away===t.id).length===34,"Incomplete schedule "+t.id);
    // Optional: snapshots built before v2.2 have no calibration block and fall back to rho 0.
    if(data.calibration!==undefined){const c=data.calibration;
      assert(Number.isFinite(c.drawRho)&&c.drawRho>=RHO_MIN&&c.drawRho<=RHO_MAX,"drawRho out of range");
      assert(Number.isInteger(c.observedGames)&&Number.isInteger(c.observedDraws)&&c.observedDraws>=0&&c.observedDraws<=c.observedGames,"Invalid draw calibration counts");}
    return {teams:teams.length,westernTeams:west.length,fixtures:fixtures.length,complete:true};
  }
  function distribution(lambda){
    let p=Math.exp(-lambda),sum=p;const a=[p];
    for(let k=1;k<50&&sum<1-1e-13;k++){p*=lambda/k;a.push(p);sum+=p;}
    return a.map(v=>v/sum);
  }
  function rates(data,config={}){
    const avg=data.teams.reduce((s,t)=>s+t.gf,0)/data.teams.reduce((s,t)=>s+t.gp,0);
    const prior=config.priorGames??8, home=config.homeLog??0.13, weight=config.recentWeight??0;
    const strengths={};
    for(const t of data.teams){let gf=t.gf/t.gp,ga=t.ga/t.gp;
      // Recent form applies to every club that has it; clubs without a form
      // sample fall back to season-long rates rather than being guessed at.
      const recent=weight&&data.recentForm?data.recentForm[t.id]:null;
      if(recent&&recent.gp>0){
        gf=(1-weight)*gf+weight*recent.gf/recent.gp;
        ga=(1-weight)*ga+weight*recent.ga/recent.gp;
      }
      strengths[t.id]={attack:(gf*t.gp+prior*avg)/(t.gp+prior),concede:(ga*t.gp+prior*avg)/(t.gp+prior)};
    }
    // Low-score correction strength: explicit config wins, then the value the
    // ingest calibrated for this snapshot, then none (plain independent Poisson).
    const rho=Math.min(RHO_MAX,Math.max(RHO_MIN,config.drawRho??data.calibration?.drawRho??0));
    return data.fixtures.map(f=>{const h=strengths[f.home],a=strengths[f.away];return{...f,
      lambdaHome:h.attack*a.concede/avg*Math.exp(home),
      lambdaAway:a.attack*h.concede/avg*Math.exp(-home),rho};});
  }
  // Dixon-Coles (1997) adjustment: independent Poissons under-produce 0-0 and 1-1
  // and over-produce 1-0 and 0-1. A negative rho shifts mass from the narrow wins
  // into the low draws; every other scoreline is untouched and the table is renormalised.
  function lowScoreFactor(hg,ag,lh,la,rho){
    if(hg===0&&ag===0)return 1-lh*la*rho;if(hg===1&&ag===0)return 1+la*rho;
    if(hg===0&&ag===1)return 1+lh*rho;if(hg===1&&ag===1)return 1-rho;return 1;
  }
  function scoreTable(f){
    const h=distribution(f.lambdaHome),a=distribution(f.lambdaAway),rho=f.rho||0,all=[],byResult={W:[],D:[],L:[]},probs={W:0,D:0,L:0};
    let total=0;
    for(let hg=0;hg<h.length;hg++)for(let ag=0;ag<a.length;ag++){const p=h[hg]*a[ag]*Math.max(1e-9,lowScoreFactor(hg,ag,f.lambdaHome,f.lambdaAway,rho)),r=hg>ag?"W":hg===ag?"D":"L";const v={hg,ag,p};all.push(v);byResult[r].push(v);probs[r]+=p;total+=p;}
    for(const r in probs)probs[r]/=total;
    const cdf=list=>{let s=0,sum=list.reduce((v,x)=>v+x.p,0);return list.map(x=>({...x,c:(s+=x.p/sum)}));};
    return {...f,probs,all:cdf(all),W:cdf(byResult.W),D:cdf(byResult.D),L:cdf(byResult.L)};
  }
  // Choose rho so the model, using this snapshot's strengths, reproduces the
  // draws actually observed across the matches actually played. One scalar,
  // fitted by bisection on a monotone target; no external constant is borrowed.
  function calibrateDrawRho(data,playedGames,config={}){
    assert(playedGames.length>0,"No played games to calibrate against");
    const observedDraws=playedGames.filter(g=>g.draw).length;
    const expectedDraws=rho=>rates({...data,fixtures:playedGames,calibration:undefined},{...config,drawRho:rho}).reduce((s,f)=>s+scoreTable(f).probs.D,0);
    const uncorrected=expectedDraws(0);
    let lo=RHO_MIN,hi=RHO_MAX;
    if(expectedDraws(lo)<observedDraws)hi=lo;else if(expectedDraws(hi)>observedDraws)lo=hi;
    else for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(expectedDraws(mid)>observedDraws)lo=mid;else hi=mid;}
    const drawRho=Math.round((lo+hi)/2*1e4)/1e4;
    return {drawRho,observedGames:playedGames.length,observedDraws,modelDrawsUncorrected:Math.round(uncorrected*100)/100,modelDrawsCorrected:Math.round(expectedDraws(drawRho)*100)/100};
  }
  function sample(list,u){let lo=0,hi=list.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(u>list[mid].c)lo=mid+1;else hi=mid;}return list[lo];}
  function compare(a,b){return b.pts-a.pts||b.wins-a.wins||b.gd-a.gd||b.gf-a.gf;}
  function applyScore(h,a,hg,ag){
    h.gf+=hg;h.gd+=hg-ag;a.gf+=ag;a.gd+=ag-hg;
    if(hg>ag){h.pts+=3;h.wins++;}else if(hg<ag){a.pts+=3;a.wins++;}else{h.pts++;a.pts++;}
  }
  function records(points,games){const arr=[];for(let w=0;w<=games;w++){const d=points-3*w,l=games-w-d;if(d>=0&&l>=0)arr.push({w,d,l});}return arr.sort((a,b)=>b.w-a.w);}
  function simulate(data,config={}){
    validate(data);
    const N=config.iterations??50000,seed=config.seed??20260914;
    assert(Number.isInteger(N)&&N>0&&N<=200000,"Invalid iteration count");
    const random=rng(seed),tables=rates(data,config).map(scoreTable),by=Object.fromEntries(data.teams.map((t,i)=>[t.id,i]));
    const west=data.teams.filter(t=>t.conference==="West"),start=data.teams.map(t=>({id:t.id,pts:t.pts,wins:t.wins,gf:t.gf,gd:t.gf-t.ga}));
    const tally=Object.fromEntries(west.map(t=>[t.id,{id:t.id,sum:0,rankSum:0,positions:Array(15).fill(0),points:{}}]));
    const thresholds={42:{n:0,qual:0},45:{n:0,qual:0}},cutoffs={};
    let unresolvedAustin=0,top9Lower=0,top9Upper=0;
    // Fixed results: "H"/"D"/"A" are from the home side's view and work for any
    // fixture; "W"/"L" are Austin's view and only make sense for Austin's own matches.
    const fixed=config.fixed||{};
    for(const [id,result] of Object.entries(fixed)){const f=data.fixtures.find(x=>x.id===id);
      assert(f&&["H","D","A","W","L"].includes(result),"Invalid fixed result "+id);
      assert(!["W","L"].includes(result)||[f.home,f.away].includes("ATX"),"Austin-relative result on a non-Austin fixture "+id);}
    const byPoints={};
    for(let iter=0;iter<N;iter++){
      const states=start.map(t=>({...t,lot:random()}));
      for(const f of tables){let key="all";const r=fixed[f.id];
        if(r)key=r==="H"?"W":r==="A"?"L":r==="D"?"D":(f.home==="ATX")===(r==="W")?"W":"L";
        const s=sample(f[key],random());applyScore(states[by[f.home]],states[by[f.away]],s.hg,s.ag);}
      const ranked=west.map(t=>states[by[t.id]]).sort((a,b)=>compare(a,b)||a.lot-b.lot);
      const atx=states[by.ATX];const better=ranked.filter(t=>compare(t,atx)<0).length,tied=ranked.filter(t=>compare(t,atx)===0).length;
      if(tied>1)unresolvedAustin++;
      if(better+tied<=9)top9Lower++;
      if(better<9)top9Upper++;
      let place=0;
      for(let i=0;i<ranked.length;i++){const t=ranked[i],z=tally[t.id];z.sum+=t.pts;z.rankSum+=i+1;z.positions[i]++;z.points[t.pts]=(z.points[t.pts]||0)+1;if(t.id==="ATX")place=i+1;}
      cutoffs[ranked[8].pts]=(cutoffs[ranked[8].pts]||0)+1;
      for(const target of [42,45])if(atx.pts>=target){thresholds[target].n++;if(place<=9)thresholds[target].qual++;}
      // Exact final total -> how often that total was enough. Answers "what does X points buy?"
      const bp=byPoints[atx.pts]||(byPoints[atx.pts]={n:0,top9:0,top7:0});bp.n++;if(place<=9)bp.top9++;if(place<=7)bp.top7++;
    }
    const quantile=(counts,p)=>{let sum=0;for(const [k,v]of Object.entries(counts).sort((a,b)=>+a[0]-b[0])){sum+=v;if(sum>=N*p)return +k;}};
    const results=west.map(t=>{const z=tally[t.id];return{id:t.id,meanPoints:z.sum/N,meanPlace:z.rankSum/N,medianPoints:quantile(z.points,.5),medianPlace:quantile(Object.fromEntries(z.positions.map((n,i)=>[i+1,n])),.5),p10:quantile(z.points,.1),p90:quantile(z.points,.9),positionPct:z.positions.map(n=>n/N*100),top9Pct:z.positions.slice(0,9).reduce((a,b)=>a+b,0)/N*100,top7Pct:z.positions.slice(0,7).reduce((a,b)=>a+b,0)/N*100};});
    const atx=results.find(t=>t.id==="ATX");
    return {version:VERSION,iterations:N,seed,config:{priorGames:config.priorGames??8,homeLog:config.homeLog??.13,recentWeight:config.recentWeight??0,drawRho:tables[0]?.rho??0},teams:results,
      atx,cutoff:{median:quantile(cutoffs,.5),p10:quantile(cutoffs,.1),p90:quantile(cutoffs,.9)},
      targets:Object.fromEntries([42,45].map(k=>[k,{reachPct:thresholds[k].n/N*100,top9GivenAtLeastTargetPct:thresholds[k].n?thresholds[k].qual/thresholds[k].n*100:null}])),
      pointsCurve:Object.keys(byPoints).map(Number).sort((x,y)=>x-y).map(p=>{const v=byPoints[p];return{pts:p,sharePct:v.n/N*100,top9Pct:v.top9/v.n*100,top7Pct:v.top7/v.n*100};}),
      unresolved:{austinAnyTiePct:unresolvedAustin/N*100,top9LowerPct:top9Lower/N*100,top9UpperPct:top9Upper/N*100},
      matches:tables.filter(f=>[f.home,f.away].includes("ATX")).map(f=>({id:f.id,date:f.date,home:f.home,away:f.away,lambdaHome:f.lambdaHome,lambdaAway:f.lambdaAway,probs:f.home==="ATX"?f.probs:{W:f.probs.L,D:f.probs.D,L:f.probs.W}}))};
  }
  return {VERSION,validate,rates,distribution,scoreTable,lowScoreFactor,calibrateDrawRho,sample,compare,applyScore,records,simulate,rng};
})();
if(typeof module!=='undefined') module.exports=VerdeModel;
