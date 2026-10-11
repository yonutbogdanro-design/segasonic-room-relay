'use strict';
// Persistent public matchmaking and a shared 60 Hz input clock.
// Each client runs the original ROM from the same start and ordered input frames.
module.exports = function publicLobby({send,error,build}) {
  const games = new Set();
  const row = () => { const open=[...games].find(g=>!g.started&&g.clients.size<3);return `PUBLICAA Public_server ${open?open.clients.size:0}`; };
  const data=(ws,line)=>send(ws,'DATA 0\n'+line+'\n');
  const broadcast=(g,line)=>{for(const ws of g.clients)data(ws,line);};
  function roster(g){
    const members=[...g.clients].sort((a,b)=>a.publicSlot-b.publicSlot);
    g.leader=members[0];
    broadcast(g,'NAMES '+Array.from({length:3},(_,i)=>members.find(ws=>ws.publicSlot===i)?.publicName||'-').join(' '));
    for(const ws of members)data(ws,'PUBLICLEADER '+(ws===g.leader?1:0));
  }
  function stop(g,reason){g.started=false;g.clockRunning=false;broadcast(g,'STOP');for(const ws of g.clients)data(ws,'NOTICE '+reason);}
  function join(ws,name){
    let g=[...games].find(g=>!g.started&&g.clients.size<3);
    if(!g){if(games.size>=90){error(ws,'Public_server_busy_try_again');return;}g={clients:new Set(),started:false,frame:0};games.add(g);}
    const occupied=new Set([...g.clients].map(client=>client.publicSlot));let slot=0;while(occupied.has(slot))slot++;
    ws.publicGame=g;ws.publicSlot=slot;ws.publicName=name;ws.publicHello=false;ws.publicInput={x:0,y:0,buttons:0,pending:0};g.clients.add(ws);
    send(ws,'JOINED PUBLICAA');
  }
  function handle(ws,lines){
    const g=ws.publicGame;if(!g)return false;
    for(const line of lines){const p=line.split(' '),cmd=p[0];
      if(cmd==='HELLO'){
        if(p.length!==4||p[1]!==build){error(ws,'Update_game_to_the_same_version');continue;}
        ws.publicHello=true;data(ws,'WELCOME '+ws.publicSlot);data(ws,'SCORES');roster(g);
      }else if(!ws.publicHello){error(ws,'Join_handshake_required');}
      else if(cmd==='PUBLICSTART'){
        const level=Number(p[1]);if(ws!==g.leader||g.started||p.length!==2||!Number.isInteger(level)||level<0||level>6)continue;
        if([...g.clients].some(client=>!client.publicHello)){data(ws,'NOTICE Waiting_for_other_players');continue;}
        let slot=0;for(const client of g.clients){client.publicSlot=slot++;client.publicInput={x:0,y:0,buttons:0,pending:0};client.publicReady=false;client.publicConsumed=-1;client.publicScene=-1;data(client,'WELCOME '+client.publicSlot);}
        roster(g);g.started=true;g.clockRunning=false;g.frame=0;g.level=level;broadcast(g,`START ${level} ${g.clients.size} 0`);
      }else if(cmd==='INPUT'){
        if(p.length!==4)continue;const [x,y,buttons]=p.slice(1).map(Number);if(![x,y,buttons].every(Number.isInteger))continue;
        const input=ws.publicInput;input.pending|=(buttons&7)&~input.buttons;input.x=Math.max(-30,Math.min(30,x));input.y=Math.max(-30,Math.min(30,y));input.buttons=buttons&7;
        if(g.started)ws.publicReady=true;
      }else if(cmd==='STATE'){
        const [frame,scene,entry]=p.slice(1).map(Number);
        if(p.length===4&&[frame,scene,entry].every(Number.isInteger)&&frame>=ws.publicConsumed&&frame<g.frame&&scene>=0&&scene<=255&&entry>=0&&entry<=255){ws.publicConsumed=frame;ws.publicScene=scene;ws.publicEntry=entry;}
      }else if(cmd==='GETSCORES')data(ws,'SCORES');
      else if(cmd==='SCORE'){/* Public ranks are not persisted by this input coordinator. */}
      else error(ws,'Invalid_public_game_command');
    }return true;
  }
  const clock=setInterval(()=>{
    const now=performance.now();
    for(const g of games){
      if(!g.started||[...g.clients].some(ws=>!ws.publicReady))continue;
      if(!g.clockRunning){g.clockRunning=true;g.nextAt=now;}
      // Bound network/render debt; no participant runs a separate game clock.
      if([...g.clients].some(ws=>g.frame-1-ws.publicConsumed>=8)){g.nextAt=now;continue;}
      for(let ticks=0;ticks<4&&now>=g.nextAt;ticks++){
        if([...g.clients].some(ws=>g.frame-1-ws.publicConsumed>=8)){g.nextAt=now;break;}
        const inputs=Array.from({length:3},()=>({x:0,y:0,buttons:0}));
        for(const ws of g.clients){const input=ws.publicInput;inputs[ws.publicSlot]={x:input.x,y:input.y,buttons:input.buttons|input.pending};input.pending=0;}
        const cinematic=[6,15,17].includes(g.leader.publicScene);
        if(cinematic&&inputs.some(input=>input.buttons&5))for(const ws of g.clients)inputs[ws.publicSlot].buttons|=5;
        broadcast(g,'F '+g.frame+++' '+inputs.map(input=>`${input.x} ${input.y} ${input.buttons}`).join(' '));g.nextAt+=1000/60;
      }
    }
  },8);clock.unref();
  function remove(ws){const g=ws.publicGame;if(!g)return false;g.clients.delete(ws);ws.publicGame=null;if(g.started)stop(g,'A_player_left_choose_a_stage_to_restart');if(!g.clients.size)games.delete(g);else roster(g);return true;}
  function close(){clearInterval(clock);games.clear();}
  return {row,join,handle,remove,close};
};
