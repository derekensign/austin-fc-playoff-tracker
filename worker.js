"use strict";
importScripts("/model.js");
self.onmessage=function(e){try{const result=VerdeModel.simulate(e.data.data,e.data.config);self.postMessage({result});}catch(err){self.postMessage({error:err.message});}};
