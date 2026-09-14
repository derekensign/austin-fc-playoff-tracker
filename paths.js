module.exports = function targetPath(matches,start,target){
 let states=new Map([[start,{score:0,path:[]}]]);
 for(const f of matches){const next=new Map();for(const [pts,s] of states)for(const p of ["W","D","L"]){const total=pts+{W:3,D:1,L:0}[p],score=s.score+Math.log(Math.max(1e-15,f.probs[p]));if(!next.has(total)||score>next.get(total).score)next.set(total,{score,path:[...s.path,p]});}states=next;}
 return states.get(target)?.path||null;
};
