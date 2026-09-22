import {analyzeCandidates} from './games/dots-and-boxes/analysis.js';
self.onmessage=({data})=>{try{const t=performance.now();self.postMessage({id:data.id,candidates:analyzeCandidates(data.state,data.difficulty),featureMs:performance.now()-t});}catch(e){self.postMessage({id:data.id,error:e.message});}};
