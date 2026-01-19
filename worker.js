// Environment variables needed:
// SUPABASE_URL, SUPABASE_KEY, SF_INSTANCE, SF_TOKEN

export default {
  async fetch(request, env) {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_KEY;
    const SF_INSTANCE = env.SF_INSTANCE;
    const SF_TOKEN = env.SF_TOKEN;
    
    const url = new URL(request.url);
    
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, {headers: {"Content-Type": "text/html"}});
    }
    
    if (request.method === "POST" && url.pathname === "/load-contacts") {
      let contacts = [];
      let queryUrl = `${SF_INSTANCE}/services/data/v59.0/query?q=` + encodeURIComponent("SELECT Id, Email, Phone, MobilePhone FROM Contact");
      
      while (queryUrl) {
        const resp = await fetch(queryUrl, {headers: {"Authorization": `Bearer ${SF_TOKEN}`}});
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
      
      return new Response(JSON.stringify({emailMap, phoneMap, count: contacts.length}), {headers: {"Content-Type": "application/json"}});
    }
    
    if (request.method === "POST" && url.pathname === "/get-aloware-batch") {
      const {offset, limit} = await request.json();
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/aloware_import?select=*&order=id&offset=${offset}&limit=${limit}`,
        {headers: {"apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`}}
      );
      return new Response(JSON.stringify(await resp.json()), {headers: {"Content-Type": "application/json"}});
    }
    
    if (request.method === "POST" && url.pathname === "/create-events") {
      const {events} = await request.json();
      const resp = await fetch(`${SF_INSTANCE}/services/data/v59.0/composite/sobjects`, {
        method: "POST",
        headers: {"Authorization": `Bearer ${SF_TOKEN}`, "Content-Type": "application/json"},
        body: JSON.stringify({allOrNone: false, records: events})
      });
      const results = await resp.json();
      const success = Array.isArray(results) ? results.filter(r => r.success).length : 0;
      const errors = Array.isArray(results) ? results.filter(r => !r.success).map(r => r.errors) : [];
      return new Response(JSON.stringify({success, errors: errors.slice(0,3)}), {headers: {"Content-Type": "application/json"}});
    }
    
    if (request.method === "POST" && url.pathname === "/delete-existing") {
      let deleted = 0;
      while (true) {
        const queryResp = await fetch(
          `${SF_INSTANCE}/services/data/v59.0/query?q=` + encodeURIComponent("SELECT Id FROM Event WHERE Original_Activity_Date__c != null LIMIT 200"),
          {headers: {"Authorization": `Bearer ${SF_TOKEN}`}}
        );
        const data = await queryResp.json();
        if (!data.records || data.records.length === 0) break;
        const ids = data.records.map(r => r.Id).join(",");
        await fetch(`${SF_INSTANCE}/services/data/v59.0/composite/sobjects?ids=${ids}&allOrNone=false`, {
          method: "DELETE", headers: {"Authorization": `Bearer ${SF_TOKEN}`}
        });
        deleted += data.records.length;
      }
      return new Response(JSON.stringify({deleted}), {headers: {"Content-Type": "application/json"}});
    }
    
    if (request.method === "GET" && url.pathname === "/count") {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/aloware_import?select=count`,
        {headers: {"apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Prefer": "count=exact"}}
      );
      const data = await resp.json();
      return new Response(JSON.stringify({count: data[0]?.count || 0}), {headers: {"Content-Type": "application/json"}});
    }
    
    return new Response("Not found", {status: 404});
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
</style></head><body>
<h1>Aloware to Salesforce Sync</h1>
<div class="info">
  <p><b>Source:</b> Supabase aloware_import table</p>
  <p><b>Target:</b> Salesforce Events with correct timestamps</p>
</div>
<div>
  <button id="deleteBtn" class="btn btn-red">1. Delete Existing Events</button>
  <button id="loadBtn" class="btn btn-blue">2. Load SF Contacts</button>
  <button id="syncBtn" class="btn btn-green" disabled>3. Start Sync</button>
</div>
<div id="progress">
  <div id="progressBar"><div id="progressFill"></div></div>
  <div id="status">Ready</div>
</div>
<div id="log"></div>

<script>
let emailMap = {}, phoneMap = {};
let totalRows = 0, processed = 0, created = 0, errors = 0, skipped = 0;

function log(msg) {
  const el = document.getElementById("log");
  el.innerHTML += "[" + new Date().toLocaleTimeString() + "] " + msg + "\\n";
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

function buildEvent(row, contactId) {
  const ts = parseTimestamp(row["Started At"]);
  if (!ts || !contactId) return null;
  
  const type = row["Type"] || "call";
  const direction = row["Direction"] || "";
  const name = ((row["Contact First Name"] || "") + " " + (row["Contact Last Name"] || "")).trim() || "Unknown";
  
  let subject = direction.charAt(0).toUpperCase() + direction.slice(1) + " ";
  subject += type === "sms" ? "SMS" : "Call";
  subject += " - " + name;
  
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
    OwnerId: "005a500001mkMsbAAE",
    CreatedDate: ts,
    LastModifiedDate: ts,
    aloware__Call_Direction__c: row["Direction"] || null,
    aloware__Call_Disposition__c: row["Call Disposition"] ? row["Call Disposition"].slice(0,255) : null,
    aloware__Disposition_Status__c: row["Disposition Status"] || null
  };
}

document.getElementById("deleteBtn").onclick = async () => {
  if (!confirm("Delete ALL existing Aloware events from Salesforce?")) return;
  document.getElementById("deleteBtn").disabled = true;
  log("Deleting existing events...");
  status("Deleting...");
  const resp = await fetch("/delete-existing", {method: "POST"});
  const data = await resp.json();
  log("Deleted " + data.deleted + " events");
  status("Deleted " + data.deleted + " events");
  document.getElementById("deleteBtn").disabled = false;
};

document.getElementById("loadBtn").onclick = async () => {
  document.getElementById("loadBtn").disabled = true;
  log("Loading Salesforce contacts...");
  status("Loading contacts...");
  const resp = await fetch("/load-contacts", {method: "POST"});
  const data = await resp.json();
  emailMap = data.emailMap;
  phoneMap = data.phoneMap;
  log("Loaded " + data.count + " contacts");
  
  const countResp = await fetch("/count");
  const countData = await countResp.json();
  totalRows = countData.count;
  log("Records to sync: " + totalRows.toLocaleString());
  status("Ready to sync " + totalRows.toLocaleString() + " records");
  document.getElementById("syncBtn").disabled = false;
  document.getElementById("loadBtn").disabled = false;
};

document.getElementById("syncBtn").onclick = async () => {
  document.getElementById("syncBtn").disabled = true;
  document.getElementById("loadBtn").disabled = true;
  document.getElementById("deleteBtn").disabled = true;
  log("Starting sync...");
  const BATCH = 200;
  
  while (processed < totalRows) {
    const batchResp = await fetch("/get-aloware-batch", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({offset: processed, limit: BATCH})
    });
    const rows = await batchResp.json();
    if (!rows || rows.length === 0) break;
    
    const events = [];
    for (const row of rows) {
      const email = row["Email"] ? row["Email"].toLowerCase() : null;
      const phone = normalizePhone(row["Contact Number"]);
      let contactId = (email && emailMap[email]) || (phone && phoneMap[phone]) || null;
      if (!contactId) { skipped++; continue; }
      const event = buildEvent(row, contactId);
      if (event) events.push(event);
      else skipped++;
    }
    
    if (events.length > 0) {
      const createResp = await fetch("/create-events", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({events})
      });
      const result = await createResp.json();
      created += result.success;
      errors += events.length - result.success;
      if (result.errors && result.errors.length > 0) log("Error: " + JSON.stringify(result.errors[0]));
    }
    
    processed += rows.length;
    progress(processed, totalRows);
    if (processed % 2000 === 0) log("Progress: " + processed.toLocaleString() + " processed, " + created + " created");
    await new Promise(r => setTimeout(r, 50));
  }
  
  log("");
  log("========== COMPLETE ==========");
  log("Processed: " + processed.toLocaleString());
  log("Created: " + created.toLocaleString());
  log("Skipped: " + skipped.toLocaleString());
  log("Errors: " + errors);
  document.getElementById("syncBtn").textContent = "Done!";
};

log("Ready. Click buttons 1, 2, 3 in order.");
</script></body></html>`;
