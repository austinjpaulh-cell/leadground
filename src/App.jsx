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
  const allServices = [...new Set(jobs.map(j => j["Service"]).filter(Boolea
