// Environment variables: SUPABASE_URL, SUPABASE_KEY, SF_INSTANCE, SF_TOKEN

export default {
  async fetch(request, env) {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_KEY;
    const SF_INSTANCE = env.SF_INSTANCE;
    const SF_TOKEN = env.SF_TOKEN;
    
    const url = new URL(request.url);
    
    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    };
    
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, {headers: {"Content-Type": "text/html"}});
    }
    
    // Health check / env check
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        env: {
          SUPABASE_URL: SUPABASE_URL ? "SET (" + SUPABASE_URL.substring(0,30) + "...)" : "MISSING",
          SUPABASE_KEY: SUPABASE_KEY ? "SET (length: " + SUPABASE_KEY.length + ")" : "MISSING",
          SF_INSTANCE: SF_INSTANCE ? "SET (" + SF_INSTANCE + ")" : "MISSING",
          SF_TOKEN: SF_TOKEN ? "SET (length: " + SF_TOKEN.length + ")" : "MISSING"
        }
      }), {headers: corsHeaders});
    }
    
    // Count Supabase records
    if (request.method === "GET" && url.pathname === "/count") {
      try {
        if (!SUPABASE_URL || !SUPABASE_KEY) {
          return new Response(JSON.stringify({error: "Missing SUPABASE_URL or SUPABASE_KEY env vars"}), {status: 500, headers: corsHeaders});
        }
        
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/aloware_import?select=id&limit=0`,
          {headers: {"apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Prefer": "count=exact"}}
        );
        
        if (!resp.ok) {
          const text = await resp.text();
          return new Response(JSON.stringify({error: "Supabase error: " + resp.status, details: text}), {status: 500, headers: corsHeaders});
        }
        
        // Count is in Content-Range header: "0-0/42000"
        const contentRange = resp.headers.get("Content-Range");
        let count = 0;
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) count = parseInt(match[1], 10);
        }
        
        return new Response(JSON.stringify({count}), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /count: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    // Count existing SF Aloware events
    if (request.method === "GET" && url.pathname === "/sf-count") {
      try {
        if (!SF_INSTANCE || !SF_TOKEN) {
          return new Response(JSON.stringify({error: "Missing SF_INSTANCE or SF_TOKEN env vars"}), {status: 500, headers: corsHeaders});
        }
        
        const resp = await fetch(
          `${SF_INSTANCE}/services/data/v59.0/query?q=` + encodeURIComponent("SELECT COUNT(Id) c FROM Event WHERE Agent__c != null"),
          {headers: {"Authorization": `Bearer ${SF_TOKEN}`}}
        );
        
        if (!resp.ok) {
          const text = await resp.text();
          return new Response(JSON.stringify({error: "Salesforce error: " + resp.status, details: text}), {status: 500, headers: corsHeaders});
        }
        
        const data = await resp.json();
        return new Response(JSON.stringify({count: data.records?.[0]?.c || 0}), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /sf-count: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    // Load SF contacts for matching
    if (request.method === "POST" && url.pathname === "/load-contacts") {
      try {
        if (!SF_INSTANCE || !SF_TOKEN) {
          return new Response(JSON.stringify({error: "Missing SF env vars"}), {status: 500, headers: corsHeaders});
        }
        
        let contacts = [];
        let queryUrl = `${SF_INSTANCE}/services/data/v59.0/query?q=` + encodeURIComponent("SELECT Id, Email, Phone, MobilePhone FROM Contact");
        
        while (queryUrl) {
          const resp = await fetch(queryUrl, {headers: {"Authorization": `Bearer ${SF_TOKEN}`}});
          if (!resp.ok) {
            const text = await resp.text();
            return new Response(JSON.stringify({error: "SF contact query failed: " + resp.status, details: text}), {status: 500, headers: corsHeaders});
          }
          const data = await resp.json();
          contacts = contacts.concat(data.records || []);
          queryUrl = data.nextRecordsUrl ? SF_INSTANCE + data.nextRecordsUrl : null;
        }
        
        const emailMap = {}, phoneMap = {};
        for (const c of contacts) {
          if (c.Email) emailMap[c.Email.toLowerCase()] = c.Id;
          if (c.Phone) phoneMap[normalizePhone(c.Phone)] = c.Id;
          if (c.MobilePhone) phoneMap[normalizePhone(c.MobilePhone)] = c.Id;
        }
        
        return new Response(JSON.stringify({emailMap, phoneMap, count: contacts.length}), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /load-contacts: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    // Load SF Agents (custom Agent__c object) for matching
    if (request.method === "POST" && url.pathname === "/load-agents") {
      try {
        if (!SF_INSTANCE || !SF_TOKEN) {
          return new Response(JSON.stringify({error: "Missing SF env vars"}), {status: 500, headers: corsHeaders});
        }
        
        const resp = await fetch(
          `${SF_INSTANCE}/services/data/v59.0/query?q=` + encodeURIComponent("SELECT Id, Name, Aloware_User_Name__c FROM Agent__c"),
          {headers: {"Authorization": `Bearer ${SF_TOKEN}`}}
        );
        
        if (!resp.ok) {
          const text = await resp.text();
          return new Response(JSON.stringify({error: "SF agent query failed: " + resp.status, details: text}), {status: 500, headers: corsHeaders});
        }
        
        const data = await resp.json();
        const agentMap = {};  // Maps Aloware username -> {id, name}
        for (const a of data.records || []) {
          // Use Aloware_User_Name__c if available, otherwise use Name
          const alowareKey = (a.Aloware_User_Name__c || a.Name || "").toLowerCase();
          if (alowareKey) {
            agentMap[alowareKey] = { id: a.Id, name: a.Name };
          }
          // Also map by Name in case User Name column uses display names
          const nameKey = (a.Name || "").toLowerCase();
          if (nameKey && !agentMap[nameKey]) {
            agentMap[nameKey] = { id: a.Id, name: a.Name };
          }
        }
        return new Response(JSON.stringify({agentMap, count: Object.keys(agentMap).length}), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /load-agents: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    // Get batch from Supabase
    if (request.method === "POST" && url.pathname === "/get-aloware-batch") {
      try {
        if (!SUPABASE_URL || !SUPABASE_KEY) {
          return new Response(JSON.stringify({error: "Missing Supabase env vars"}), {status: 500, headers: corsHeaders});
        }
        
        const {offset, limit} = await request.json();
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/aloware_import?select=*&order=id&offset=${offset}&limit=${limit}`,
          {headers: {"apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`}}
        );
        
        if (!resp.ok) {
          const text = await resp.text();
          return new Response(JSON.stringify({error: "Supabase batch query failed: " + resp.status, details: text}), {status: 500, headers: corsHeaders});
        }
        
        return new Response(JSON.stringify(await resp.json()), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /get-aloware-batch: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    // Create events in SF
    if (request.method === "POST" && url.pathname === "/create-events") {
      try {
        if (!SF_INSTANCE || !SF_TOKEN) {
          return new Response(JSON.stringify({error: "Missing SF env vars"}), {status: 500, headers: corsHeaders});
        }
        
        const {events} = await request.json();
        const resp = await fetch(`${SF_INSTANCE}/services/data/v59.0/composite/sobjects`, {
          method: "POST",
          headers: {"Authorization": `Bearer ${SF_TOKEN}`, "Content-Type": "application/json"},
          body: JSON.stringify({allOrNone: false, records: events})
        });
        
        if (!resp.ok) {
          const text = await resp.text();
          return new Response(JSON.stringify({error: "SF create failed: " + resp.status, details: text}), {status: 500, headers: corsHeaders});
        }
        
        const results = await resp.json();
        const success = Array.isArray(results) ? results.filter(r => r.success).length : 0;
        const errors = Array.isArray(results) ? results.filter(r => !r.success).map(r => r.errors) : [];
        return new Response(JSON.stringify({success, errors: errors.slice(0,3)}), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /create-events: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    // Delete ALL Aloware events (those with Agent__c set)
    if (request.method === "POST" && url.pathname === "/delete-existing") {
      try {
        if (!SF_INSTANCE || !SF_TOKEN) {
          return new Response(JSON.stringify({error: "Missing SF env vars"}), {status: 500, headers: corsHeaders});
        }
        
        let deleted = 0;
        while (true) {
          // Query events that have Agent__c populated (Aloware events)
          const queryResp = await fetch(
            `${SF_INSTANCE}/services/data/v59.0/query?q=` + encodeURIComponent("SELECT Id FROM Event WHERE Agent__c != null LIMIT 200"),
            {headers: {"Authorization": `Bearer ${SF_TOKEN}`}}
          );
          
          if (!queryResp.ok) {
            const text = await queryResp.text();
            return new Response(JSON.stringify({error: "SF delete query failed: " + queryResp.status, details: text, deleted}), {status: 500, headers: corsHeaders});
          }
          
          const data = await queryResp.json();
          if (!data.records || data.records.length === 0) break;
          const ids = data.records.map(r => r.Id).join(",");
          await fetch(`${SF_INSTANCE}/services/data/v59.0/composite/sobjects?ids=${ids}&allOrNone=false`, {
            method: "DELETE", headers: {"Authorization": `Bearer ${SF_TOKEN}`}
          });
          deleted += data.records.length;
        }
        return new Response(JSON.stringify({deleted}), {headers: corsHeaders});
      } catch (e) {
        return new Response(JSON.stringify({error: "Exception in /delete-existing: " + e.message}), {status: 500, headers: corsHeaders});
      }
    }
    
    return new Response(JSON.stringify({error: "Not found: " + url.pathname}), {status: 404, headers: corsHeaders});
  }
};

function normalizePhone(phone) {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

const HTML = `<!DOCTYPE html><html><head><title>Aloware to Salesforce Sync</title>
<style>
body{font-family:Arial;max-width:800px;margin:50px auto;padding:20px}
h1{color:#333}
.btn{padding:12px 24px;font-size:16px;cursor:pointer;margin:5px;border-radius:5px;border:none}
.btn-green{background:#4CAF50;color:white}
.btn-red{background:#f44336;color:white}
.btn-blue{background:#2196F3;color:white}
.btn:disabled{background:#ccc;cursor:not-allowed}
#progress{margin:20px 0}
#progressBar{width:100%;height:30px;background:#eee;border-radius:5px}
#progressFill{height:100%;background:#4CAF50;width:0%;transition:width 0.3s}
#status{margin:10px 0;font-size:18px;font-weight:bold}
#log{background:#1e1e1e;color:#0f0;padding:15px;height:300px;overflow-y:auto;font-family:monospace;font-size:12px;border-radius:5px}
.info{background:#e3f2fd;padding:15px;border-radius:5px;margin:10px 0}
.warn{background:#fff3e0;padding:15px;border-radius:5px;margin:10px 0}
.error{color:#f44;font-weight:bold}
</style></head><body>
<h1>Aloware to Salesforce Sync</h1>
<div class="info">
  <p><b>Source:</b> Supabase aloware_import table</p>
  <p><b>Target:</b> Salesforce Events</p>
  <p><b>Subject format:</b> "Direction Type - Contact Name | Agent Name"</p>
  <p><b>Key fields set:</b> CreatedDate, LastModifiedDate, Agent__c, Original_Activity_Date__c</p>
</div>
<div class="warn">
  <p><b>Step 1</b> deletes ALL existing Aloware events (where Agent__c is set). This prevents duplicates.</p>
</div>
<div id="counts"></div>
<div>
  <button id="healthBtn" class="btn btn-blue">Check Health</button>
  <button id="countBtn" class="btn btn-blue">Check Counts</button>
  <button id="deleteBtn" class="btn btn-red">1. Delete Existing Aloware Events</button>
  <button id="loadBtn" class="btn btn-blue">2. Load Contacts & Agents</button>
  <button id="syncBtn" class="btn btn-green" disabled>3. Start Sync</button>
</div>
<div id="progress">
  <div id="progressBar"><div id="progressFill"></div></div>
  <div id="status">Ready</div>
</div>
<div id="log"></div>

<script>
let emailMap = {}, phoneMap = {}, agentMap = {};
let totalRows = 0, processed = 0, created = 0, errors = 0, skipped = 0;

function log(msg, isError) {
  const el = document.getElementById("log");
  const cls = isError ? ' class="error"' : '';
  el.innerHTML += '<div' + cls + '>[' + new Date().toLocaleTimeString() + '] ' + msg + '</div>';
  el.scrollTop = el.scrollHeight;
}

function status(msg) { document.getElementById("status").textContent = msg; }

function progress(done, total) {
  const pct = total > 0 ? (done / total * 100).toFixed(1) : 0;
  document.getElementById("progressFill").style.width = pct + "%";
  status(done.toLocaleString() + " / " + total.toLocaleString() + " (" + pct + "%) - Created: " + created + " Skipped: " + skipped + " Errors: " + errors);
}

function normalizePhone(phone) {
  if (!phone) return "";
  const digits = phone.replace(/\\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function parseTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts.replace(" ", "T"));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace("Z", "+0000");
}

function buildEvent(row, contactId, agentInfo) {
  const ts = parseTimestamp(row["Started At"]);
  if (!ts || !contactId) return null;
  
  const type = row["Type"] || "call";
  const direction = row["Direction"] || "";
  const contactName = ((row["Contact First Name"] || "") + " " + (row["Contact Last Name"] || "")).trim() || "Unknown";
  const agentName = agentInfo ? agentInfo.name : null;
  
  // Build subject with agent name visible: "Outbound SMS - John Damaso | Jack Russo"
  let subject = direction.charAt(0).toUpperCase() + direction.slice(1) + " ";
  subject += type === "sms" ? "SMS" : "Call";
  subject += " - " + contactName;
  if (agentName) {
    subject += " | " + agentName;
  }
  
  const endTs = new Date(new Date(ts).getTime() + 15*60000).toISOString().replace("Z", "+0000");
  const desc = [row["Body"], row["Notes"], row["Recording"], row["Voicemail"]].filter(Boolean).join("\\n");
  
  return {
    attributes: {type: "Event"},
    Subject: subject.slice(0, 255),
    WhoId: contactId,
    StartDateTime: ts,
    EndDateTime: endTs,
    Description: desc ? desc.slice(0, 32000) : null,
    Original_Activity_Date__c: ts,
    Agent__c: agentInfo ? agentInfo.id : null,
    OwnerId: "005a500001mkMsbAAE",
    CreatedDate: ts,
    LastModifiedDate: ts,
    aloware__Call_Direction__c: row["Direction"] || null,
    aloware__Call_Disposition__c: row["Call Disposition"] ? row["Call Disposition"].slice(0,255) : null,
    aloware__Disposition_Status__c: row["Disposition Status"] || null
  };
}

async function safeJson(resp, endpoint) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    log("ERROR: " + endpoint + " returned non-JSON: " + text.substring(0, 200), true);
    throw new Error("Non-JSON response from " + endpoint);
  }
}

document.getElementById("healthBtn").onclick = async () => {
  log("Checking environment variables...");
  try {
    const resp = await fetch("/health");
    const data = await safeJson(resp, "/health");
    log("Environment check:");
    log("  SUPABASE_URL: " + data.env.SUPABASE_URL);
    log("  SUPABASE_KEY: " + data.env.SUPABASE_KEY);
    log("  SF_INSTANCE: " + data.env.SF_INSTANCE);
    log("  SF_TOKEN: " + data.env.SF_TOKEN);
    
    const missing = Object.entries(data.env).filter(([k,v]) => v === "MISSING");
    if (missing.length > 0) {
      log("MISSING ENV VARS: " + missing.map(([k]) => k).join(", "), true);
      status("Missing environment variables!");
    } else {
      log("All environment variables are set!");
      status("Environment OK");
    }
  } catch (e) {
    log("Health check failed: " + e.message, true);
  }
};

document.getElementById("countBtn").onclick = async () => {
  log("Checking counts...");
  try {
    const [sbResp, sfResp] = await Promise.all([fetch("/count"), fetch("/sf-count")]);
    const sbData = await safeJson(sbResp, "/count");
    const sfData = await safeJson(sfResp, "/sf-count");
    
    if (sbData.error) {
      log("Supabase count error: " + sbData.error + (sbData.details ? " - " + sbData.details : ""), true);
    }
    if (sfData.error) {
      log("Salesforce count error: " + sfData.error + (sfData.details ? " - " + sfData.details : ""), true);
    }
    
    document.getElementById("counts").innerHTML = 
      "<p><b>Supabase records:</b> " + (sbData.count !== undefined ? sbData.count.toLocaleString() : sbData.error) + "</p>" +
      "<p><b>SF Aloware events:</b> " + (sfData.count !== undefined ? sfData.count.toLocaleString() : sfData.error) + "</p>";
    log("Supabase: " + (sbData.count !== undefined ? sbData.count : sbData.error) + ", SF: " + (sfData.count !== undefined ? sfData.count : sfData.error));
  } catch (e) {
    log("Count check failed: " + e.message, true);
  }
};

document.getElementById("deleteBtn").onclick = async () => {
  if (!confirm("Delete ALL existing Aloware events (where Agent__c is set)?")) return;
  document.getElementById("deleteBtn").disabled = true;
  log("Deleting existing Aloware events...");
  status("Deleting...");
  try {
    const resp = await fetch("/delete-existing", {method: "POST"});
    const data = await safeJson(resp, "/delete-existing");
    if (data.error) {
      log("Delete error: " + data.error + (data.details ? " - " + data.details : ""), true);
    } else {
      log("Deleted " + data.deleted + " events");
      status("Deleted " + data.deleted + " events");
    }
  } catch (e) {
    log("Delete failed: " + e.message, true);
  }
  document.getElementById("deleteBtn").disabled = false;
};

document.getElementById("loadBtn").onclick = async () => {
  document.getElementById("loadBtn").disabled = true;
  
  try {
    log("Loading Salesforce contacts...");
    status("Loading contacts...");
    const contactResp = await fetch("/load-contacts", {method: "POST"});
    const contactData = await safeJson(contactResp, "/load-contacts");
    
    if (contactData.error) {
      log("Contact load error: " + contactData.error + (contactData.details ? " - " + contactData.details : ""), true);
      document.getElementById("loadBtn").disabled = false;
      return;
    }
    
    emailMap = contactData.emailMap;
    phoneMap = contactData.phoneMap;
    log("Loaded " + contactData.count + " contacts (" + Object.keys(emailMap).length + " emails, " + Object.keys(phoneMap).length + " phones)");
    
    log("Loading Salesforce agents (Agent__c records)...");
    const agentResp = await fetch("/load-agents", {method: "POST"});
    const agentData = await safeJson(agentResp, "/load-agents");
    
    if (agentData.error) {
      log("Agent load error: " + agentData.error + (agentData.details ? " - " + agentData.details : ""), true);
      document.getElementById("loadBtn").disabled = false;
      return;
    }
    
    agentMap = agentData.agentMap;
    log("Loaded " + agentData.count + " agents: " + Object.keys(agentMap).slice(0,5).join(", ") + "...");
    
    const countResp = await fetch("/count");
    const countData = await safeJson(countResp, "/count");
    
    if (countData.error) {
      log("Count error: " + countData.error, true);
      document.getElementById("loadBtn").disabled = false;
      return;
    }
    
    totalRows = countData.count;
    log("Records to sync: " + totalRows.toLocaleString());
    
    status("Ready to sync " + totalRows.toLocaleString() + " records");
    document.getElementById("syncBtn").disabled = false;
  } catch (e) {
    log("Load failed: " + e.message, true);
  }
  document.getElementById("loadBtn").disabled = false;
};

document.getElementById("syncBtn").onclick = async () => {
  document.getElementById("syncBtn").disabled = true;
  document.getElementById("loadBtn").disabled = true;
  document.getElementById("deleteBtn").disabled = true;
  log("Starting sync...");
  const BATCH = 200;
  
  try {
    while (processed < totalRows) {
      const batchResp = await fetch("/get-aloware-batch", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({offset: processed, limit: BATCH})
      });
      const rows = await safeJson(batchResp, "/get-aloware-batch");
      
      if (rows.error) {
        log("Batch error: " + rows.error, true);
        break;
      }
      
      if (!rows || rows.length === 0) break;
      
      const events = [];
      for (const row of rows) {
        const email = row["Email"] ? row["Email"].toLowerCase() : null;
        const phone = normalizePhone(row["Contact Number"]);
        let contactId = (email && emailMap[email]) || (phone && phoneMap[phone]) || null;
        
        if (!contactId) { skipped++; continue; }
        
        // Look up agent by "User Name" column from Aloware
        const userName = row["User Name"] ? row["User Name"].toLowerCase() : null;
        const agentInfo = userName ? agentMap[userName] : null;
        
        const event = buildEvent(row, contactId, agentInfo);
        if (event) events.push(event);
        else skipped++;
      }
      
      if (events.length > 0) {
        const createResp = await fetch("/create-events", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({events})
        });
        const result = await safeJson(createResp, "/create-events");
        
        if (result.error) {
          log("Create error: " + result.error, true);
          errors += events.length;
        } else {
          created += result.success;
          errors += events.length - result.success;
          if (result.errors && result.errors.length > 0) log("Error: " + JSON.stringify(result.errors[0]));
        }
      }
      
      processed += rows.length;
      progress(processed, totalRows);
      if (processed % 2000 === 0) log("Progress: " + processed.toLocaleString() + " processed, " + created + " created");
      await new Promise(r => setTimeout(r, 50));
    }
  } catch (e) {
    log("Sync failed: " + e.message, true);
  }
  
  log("");
  log("========== COMPLETE ==========");
  log("Processed: " + processed.toLocaleString());
  log("Created: " + created.toLocaleString());
  log("Skipped (no contact match): " + skipped.toLocaleString());
  log("Errors: " + errors);
  document.getElementById("syncBtn").textContent = "Done!";
};

log("Ready. Click 'Check Health' first to verify environment variables.");
</script></body></html>`;
