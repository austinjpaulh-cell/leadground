import { useState, useEffect, useRef } from "react";

const JSONBIN_URL = "https://api.jsonbin.io/v3/b/69e3fe8a856a6821894b16fe/latest";
const fmt = n => "$" + Math.round(Number(n) || 0).toLocaleString();
const fmtDate = d => { try { return new Date(d).toLocaleDateString(); } catch { return d; } };

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [syncError, setSyncError] = useState("");
  const [tab, setTab] = useState("overview");
  const [fSource, setFSource] = useState("All");
  const [fService, setFService] = useState("All");
  const [msgs, setMsgs] = useState([{role:"assistant", content:"Hi! I have your live Square data. Ask me anything — \"Which lead source makes the most money?\", \"What's my average ticket?\", or \"Who are my top customers?\""}]);
  const [inp, setInp] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const chatEnd = useRef(null);

  useEffect(() => { chatEnd.current?.scrollIntoView({behavior:"smooth"}); }, [msgs]);

  const fetchData = async () => {
    setLoading(true);
    setSyncError("");
    try {
      const r = await fetch(JSONBIN_URL, {
        headers: { "X-Bin-Meta": "false" }
      });
      if (!r.ok) throw new Error("Failed");
      const data = await r.json();
      const jobList = Array.isArray(data) ? data : (data.jobs || []);
      setJobs(jobList);
      setLastSync(new Date());
    } catch(e) {
      setSyncError("Could not load data. Try refreshing.");
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const totalRevenue = jobs.reduce((s, j) => s + (Number(j["Payment Amount"]) || 0), 0);
  const avgTicket = jobs.length ? totalRevenue / jobs.length : 0;
  const uniqueCustomers = [...new Set(jobs.map(j => j["Customer Name"]))].length;

  const sourceStats = [...new Set(jobs.map(j => j["Lead Source"]).filter(Boolean))].map(src => {
    const group = jobs.filter(j => j["Lead Source"] === src);
    const rev = group.reduce((s, j) => s + (Number(j["Payment Amount"]) || 0), 0);
    return { src, jobs: group.length, revenue: rev, avg: group.length ? rev / group.length : 0 };
  }).sort((a, b) => b.revenue - a.revenue);

  const serviceStats = [...new Set(jobs.map(j => j["Service"]).filter(Boolean))].map(svc => {
    const group = jobs.filter(j => j["Service"] === svc);
    const rev = group.reduce((s, j) => s + (Number(j["Payment Amount"]) || 0), 0);
    return { svc, jobs: group.length, revenue: rev, avg: group.length ? rev / group.length : 0 };
  }).sort((a, b) => b.avg - a.avg);

  const customerLTV = [...new Set(jobs.map(j => j["Customer Name"]).filter(Boolean))].map(name => {
    const group = jobs.filter(j => j["Customer Name"] === name);
    const total = group.reduce((s, j) => s + (Number(j["Payment Amount"]) || 0), 0);
    const lastJob = group[group.length - 1];
    return { name, jobs: group.length, total, source: group[0]?.["Lead Source"] || "—", lastService: lastJob?.["Service"] || "", lastDate: lastJob?.["Date"] || "" };
  }).sort((a, b) => b.total - a.total);

  const allSources = [...new Set(jobs.map(j => j["Lead Source"]).filter(Boolean))];
  const allServices = [...new Set(jobs.map(j => j["Service"]).filter(Boolean))];
  const filtered = jobs.filter(j => {
    if (fSource !== "All" && j["Lead Source"] !== fSource) return false;
    if (fService !== "All" && j["Service"] !== fService) return false;
    return true;
  });

  const sendAi = async () => {
    if (!inp.trim() || aiLoading) return;
    const q = inp.trim(); setInp("");
    setMsgs(m => [...m, {role:"user", content:q}]);
    setAiLoading(true);
    const ctx = `You are a business intelligence assistant for Two Guys Energy Solutions, a home services company in Boise, Idaho. Real jobs data: ${JSON.stringify(jobs)}. Metrics: total jobs=${jobs.length}, revenue=${fmt(totalRevenue)}, avg ticket=${fmt(avgTicket)}, customers=${uniqueCustomers}. Answer under 150 words with specific numbers.`;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:ctx,
          messages:[...msgs.slice(1).map(m=>({role:m.role,content:m.content})),{role:"user",content:q}]})
      });
      const d = await r.json();
      setMsgs(m => [...m, {role:"assistant", content: d.content?.map(c=>c.text||"").join("")||"Try again."}]);
    } catch { setMsgs(m => [...m, {role:"assistant", content:"Connection error."}]); }
    setAiLoading(false);
  };

  const s = {
    card: {background:"#1e2535",border:"1px solid #2a3545",borderRadius:12,padding:"16px 18px"},
    lbl: {fontSize:10,color:"#64748b",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6,display:"block"},
    inp: {width:"100%",background:"#131825",border:"1px solid #2a3545",borderRadius:8,padding:"8px 12px",color:"#e2e8f0",fontSize:12,fontFamily:"inherit",boxSizing:"border-box",outline:"none"},
    btn: {background:"#22c55e",border:"none",borderRadius:8,padding:"8px 16px",color:"#fff",fontFamily:"inherit",fontSize:12,cursor:"pointer",fontWeight:500},
    ghost: {background:"#1e2535",border:"1px solid #2a3545",borderRadius:8,padding:"8px 14px",color:"#94a3b8",fontFamily:"inherit",fontSize:12,cursor:"pointer"},
    row: {display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #2a3545"},
  };

  const TABS = ["overview","jobs","sources","services","customers","ai insights"];

  if (loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",flexDirection:"column",gap:12,fontFamily:"system-ui",background:"#0f1117",color:"#e2e8f0"}}>
      <div style={{width:40,height:40,background:"#22c55e",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>🌿</div>
      <div style={{fontSize:14}}>Loading your live data...</div>
      {syncError && <div style={{fontSize:12,color:"#ef4444"}}>{syncError}</div>}
    </div>
  );

  return (
    <div style={{fontFamily:"system-ui,sans-serif",background:"#0f1117",minHeight:"100vh",color:"#e2e8f0"}}>
      <div style={{background:"#0a0d14",borderBottom:"1px solid #1e2535",padding:"13px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,background:"#22c55e",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🌿</div>
          <div>
            <div style={{fontWeight:600,fontSize:16,color:"#f1f5f9"}}>LeadGround</div>
            <div style={{fontSize:10,color:"#64748b",letterSpacing:"0.06em"}}>TWO GUYS ENERGY SOLUTIONS · LIVE DATA</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {syncError && <span style={{fontSize:11,color:"#ef4444"}}>{syncError}</span>}
          {lastSync && <span style={{fontSize:11,color:"#64748b"}}>Updated {lastSync.toLocaleTimeString()}</span>}
          <button onClick={fetchData} style={{...s.ghost,fontSize:11}}>↻ Refresh</button>
        </div>
      </div>

      <div style={{background:"#0a0d14",borderBottom:"1px solid #1e2535",display:"flex",padding:"0 24px",overflowX:"auto"}}>
        {TABS.map(t => (
          <button key={t} onClick={()=>setTab(t)} style={{background:"none",border:"none",borderBottom:tab===t?"2px solid #22c55e":"2px solid transparent",color:tab===t?"#22c55e":"#64748b",padding:"11px 16px",fontSize:11,letterSpacing:"0.07em",textTransform:"uppercase",cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0}}>
            {t === "ai insights" ? "⚡ " + t : t}
          </button>
        ))}
      </div>

      <div style={{padding:24,maxWidth:1200,margin:"0 auto"}}>

        {tab === "overview" && (
          <div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:14,marginBottom:20}}>
              {[
                {label:"Total Jobs",val:jobs.length,sub:"completed & paid",color:"#3b82f6"},
                {label:"Total Revenue",val:fmt(totalRevenue),sub:"all time",color:"#22c55e"},
                {label:"Avg Ticket",val:fmt(avgTicket),sub:"per job",color:"#8b5cf6"},
                {label:"Unique Customers",val:uniqueCustomers,sub:"in Square",color:"#f59e0b"},
              ].map(({label,val,sub,color})=>(
                <div key={label} style={s.card}>
                  <div style={s.lbl}>{label}</div>
                  <div style={{fontSize:24,fontWeight:600,color}}>{val}</div>
                  <div style={{fontSize:11,color:"#64748b",marginTop:4}}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
              <div style={s.card}>
                <div style={{...s.lbl,marginBottom:14}}>Revenue by Lead Source</div>
                {sourceStats.length === 0
                  ? <div style={{fontSize:13,color:"#64748b"}}>No source data yet — assign customers to groups in Square</div>
                  : sourceStats.map(({src,jobs:j,revenue,avg})=>(
                    <div key={src} style={s.row}>
                      <div>
                        <div style={{fontSize:13,color:"#e2e8f0"}}>{src}</div>
                        <div style={{fontSize:11,color:"#64748b"}}>{j} jobs · {fmt(revenue)} total</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:14,color:"#22c55e",fontWeight:500}}>{fmt(avg)}</div>
                        <div style={{fontSize:10,color:"#64748b"}}>avg ticket</div>
                      </div>
                    </div>
                  ))
                }
              </div>
              <div style={s.card}>
                <div style={{...s.lbl,marginBottom:14}}>Top Services by Avg Ticket</div>
                {serviceStats.length === 0
                  ? <div style={{fontSize:13,color:"#64748b"}}>No service data yet</div>
                  : serviceStats.slice(0,6).map(({svc,jobs:j,avg})=>(
                    <div key={svc} style={s.row}>
                      <div>
                        <div style={{fontSize:13,color:"#e2e8f0"}}>{svc}</div>
                        <div style={{fontSize:11,color:"#64748b"}}>{j} jobs</div>
                      </div>
                      <div style={{fontSize:14,color:"#8b5cf6",fontWeight:500}}>{fmt(avg)}</div>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        )}

        {tab === "jobs" && (
          <div>
            <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
              {[["Source",fSource,setFSource,["All",...allSources]],["Service",fService,setFService,["All",...allServices]]].map(([lbl,v,set,opts])=>(
                <div key={lbl} style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:11,color:"#64748b"}}>{lbl}:</span>
                  <select value={v} onChange={e=>set(e.target.value)} style={{...s.inp,width:"auto",padding:"5px 8px"}}>
                    {opts.map(o=><option key={o}>{o}</option>)}
                  </select>
                </div>
              ))}
              <span style={{fontSize:11,color:"#64748b"}}>{filtered.length} jobs</span>
            </div>
            <div style={{...s.card,padding:0,overflow:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead>
                  <tr style={{borderBottom:"1px solid #2a3545"}}>
                    {["Date","Customer","Lead Source","Service","Amount"].map(h=>(
                      <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#64748b",letterSpacing:"0.07em",textTransform:"uppercase",fontWeight:500,whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((j,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #1e2535",background:i%2===0?"transparent":"#131825"}}>
                      <td style={{padding:"10px 14px",color:"#94a3b8",whiteSpace:"nowrap"}}>{fmtDate(j["Date"])}</td>
                      <td style={{padding:"10px 14px",fontWeight:500,color:"#e2e8f0"}}>{j["Customer Name"]}</td>
                      <td style={{padding:"10px 14px",color:"#94a3b8"}}>{j["Lead Source"]||"—"}</td>
                      <td style={{padding:"10px 14px",color:"#94a3b8"}}>{j["Service"]}</td>
                      <td style={{padding:"10px 14px",color:"#22c55e",fontWeight:500}}>{fmt(j["Payment Amount"])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <div style={{padding:24,textAlign:"center",color:"#64748b"}}>No jobs match your filters</div>}
            </div>
          </div>
        )}

        {tab === "sources" && (
          <div>
            {sourceStats.length === 0
              ? <div style={{...s.card,textAlign:"center",padding:48}}><div style={{color:"#64748b"}}>No source data yet. Assign customers to groups in Square.</div></div>
              : <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:16}}>
                {sourceStats.map(({src,jobs:j,revenue,avg})=>{
                  const pct = sourceStats[0].revenue ? Math.round(revenue/sourceStats[0].revenue*100) : 0;
                  return (
                    <div key={src} style={s.card}>
                      <div style={{fontWeight:600,fontSize:14,color:"#f1f5f9",marginBottom:14}}>{src}</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                        <div><div style={s.lbl}>Jobs</div><div style={{fontSize:22,fontWeight:600,color:"#3b82f6"}}>{j}</div></div>
                        <div><div style={s.lbl}>Avg Ticket</div><div style={{fontSize:22,fontWeight:600,color:"#22c55e"}}>{fmt(avg)}</div></div>
                        <div style={{gridColumn:"1/-1"}}><div style={s.lbl}>Total Revenue</div><div style={{fontSize:18,fontWeight:500,color:"#e2e8f0"}}>{fmt(revenue)}</div></div>
                      </div>
                      <div style={{background:"#131825",borderRadius:4,height:5}}>
                        <div style={{height:"100%",width:pct+"%",background:"#22c55e",borderRadius:4}}/>
                      </div>
                      <div style={{fontSize:10,color:"#64748b",marginTop:6}}>{pct}% of top source</div>
                    </div>
                  );
                })}
              </div>
            }
          </div>
        )}

        {tab === "services" && (
          <div>
            {serviceStats.length === 0
              ? <div style={{...s.card,textAlign:"center",padding:48}}><div style={{color:"#64748b"}}>No service data yet.</div></div>
              : <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:16}}>
                {serviceStats.map(({svc,jobs:j,revenue,avg})=>{
                  const pct = serviceStats[0].avg ? Math.round(avg/serviceStats[0].avg*100) : 0;
                  return (
                    <div key={svc} style={s.card}>
                      <div style={{fontWeight:600,fontSize:14,color:"#f1f5f9",marginBottom:14}}>{svc}</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                        <div><div style={s.lbl}>Jobs</div><div style={{fontSize:22,fontWeight:600,color:"#3b82f6"}}>{j}</div></div>
                        <div><div style={s.lbl}>Avg Ticket</div><div style={{fontSize:22,fontWeight:600,color:"#8b5cf6"}}>{fmt(avg)}</div></div>
                        <div style={{gridColumn:"1/-1"}}><div style={s.lbl}>Total Revenue</div><div style={{fontSize:18,fontWeight:500,color:"#e2e8f0"}}>{fmt(revenue)}</div></div>
                      </div>
                      <div style={{background:"#131825",borderRadius:4,height:5}}>
                        <div style={{height:"100%",width:pct+"%",background:"#8b5cf6",borderRadius:4}}/>
                      </div>
                      <div style={{fontSize:10,color:"#64748b",marginTop:6}}>{pct}% of top service avg</div>
                    </div>
                  );
                })}
              </div>
            }
          </div>
        )}

        {tab === "customers" && (
          <div style={{...s.card,padding:0,overflow:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{borderBottom:"1px solid #2a3545"}}>
                  {["Customer","Lead Source","Jobs","Last Service","Last Date","Total LTV"].map(h=>(
                    <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#64748b",letterSpacing:"0.07em",textTransform:"uppercase",fontWeight:500,whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customerLTV.map((c,i)=>(
                  <tr key={c.name} style={{borderBottom:"1px solid #1e2535",background:i%2===0?"transparent":"#131825"}}>
                    <td style={{padding:"10px 14px",fontWeight:500,color:"#e2e8f0"}}>{c.name}</td>
                    <td style={{padding:"10px 14px",color:"#94a3b8"}}>{c.source}</td>
                    <td style={{padding:"10px 14px",color:"#3b82f6",fontWeight:500}}>{c.jobs}</td>
                    <td style={{padding:"10px 14px",color:"#94a3b8"}}>{c.lastService}</td>
                    <td style={{padding:"10px 14px",color:"#64748b",whiteSpace:"nowrap"}}>{fmtDate(c.lastDate)}</td>
                    <td style={{padding:"10px 14px",color:"#22c55e",fontWeight:500}}>{fmt(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {customerLTV.length === 0 && <div style={{padding:24,textAlign:"center",color:"#64748b"}}>No customer data yet</div>}
          </div>
        )}

        {tab === "ai insights" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 260px",gap:16}}>
            <div style={{...s.card,display:"flex",flexDirection:"column",height:500,padding:0}}>
              <div style={{padding:"12px 18px",borderBottom:"1px solid #2a3545",fontSize:10,color:"#64748b",letterSpacing:"0.07em",textTransform:"uppercase"}}>
                ⚡ AI Insights · {jobs.length} jobs loaded
              </div>
              <div style={{flex:1,overflowY:"auto",padding:16,display:"flex",flexDirection:"column",gap:12}}>
                {msgs.map((m,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                    <div style={{maxWidth:"82%",padding:"10px 14px",borderRadius:m.role==="user"?"12px 12px 2px 12px":"12px 12px 12px 2px",background:m.role==="user"?"#1e3a5f":"#1e2535",border:"1px solid #2a3545",fontSize:13,lineHeight:1.6,color:"#e2e8f0"}}>
                      {m.content}
                    </div>
                  </div>
                ))}
                {aiLoading && (
                  <div style={{display:"flex",gap:4,padding:"10px 14px",background:"#1e2535",border:"1px solid #2a3545",borderRadius:"12px 12px 12px 2px",width:"fit-content"}}>
                    {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:"#22c55e",animation:`blink 1s ${i*0.25}s infinite`}}/>)}
                  </div>
                )}
                <div ref={chatEnd}/>
              </div>
              <div style={{padding:12,borderTop:"1px solid #2a3545",display:"flex",gap:8}}>
                <input value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendAi()} placeholder="Ask about your revenue data..." style={{...s.inp,flex:1}}/>
                <button onClick={sendAi} disabled={aiLoading} style={s.btn}>Send</button>
              </div>
            </div>
            <div style={s.card}>
              <div style={{...s.lbl,marginBottom:14}}>Try Asking</div>
              {["Which lead source makes the most money?","What's my average ticket?","Who are my top customers by LTV?","Which service has the highest avg ticket?","What's my total revenue?","How many jobs completed?"].map((q,i)=>(
                <button key={i} onClick={()=>setInp(q)} style={{display:"block",width:"100%",textAlign:"left",background:"none",border:"1px solid #2a3545",borderRadius:8,padding:"8px 10px",color:"#94a3b8",fontSize:11,cursor:"pointer",marginBottom:8,fontFamily:"inherit",lineHeight:1.5}}>{q}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes blink{0%,100%{opacity:0.3}50%{opacity:1}} * { box-sizing: border-box; } body { margin: 0; }`}</style>
    </div>
  );
}
