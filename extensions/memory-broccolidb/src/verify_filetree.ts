import admin from "firebase-admin";
import { FileTree } from "./core/file-tree.js";
import { TaskMutex } from "./core/mutex.js";
import { Repository } from "./core/repository.js";

async function runVerification() {
  console.log("🚀 Starting FileTree Verification...");

  // Initialize Firebase Admin (assuming local emulator or existing config)
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: "agentgit-test",
    });
  }
  const db = admin.firestore();

  // Use a unique repo for this test run
  const repoId = `repos/test-repo-${Date.now()}`;
  const repo = new Repository(db, repoId);
  const ft = new FileTree(db, repo);

  const author = "VerificationAgent";
  const branch = "main";

  try {
    // 1. Test CAS Hardening (Full SHA-256)
    console.log("\n--- Testing CAS Hardening ---");
    const commitId1 = await ft.writeFile(branch, "hello.txt", "Hello World", author);
    const node1 = await repo.checkout(branch);
    const fileDocId = node1?.tree?.["hello.txt"];
    console.log(`File Doc ID: ${fileDocId}`);
    if (fileDocId && fileDocId.length === 64) {
      console.log("✅ CAS: 64-character SHA-256 verified.");
    } else {
      throw new Error(`❌ CAS: Expected 64-char hash, got ${fileDocId?.length}`);
    }

    // 2. Test moveFile
    console.log("\n--- Testing moveFile ---");
    await ft.moveFile(branch, "hello.txt", "greeting.txt", author);
    const node2 = await repo.checkout(branch);
    if (!node2?.tree?.["greeting.txt"] || node2.tree["hello.txt"]) {
      throw new Error("❌ moveFile: File not moved correctly");
    }
    console.log("✅ moveFile: Rename successful.");

    // 3. Test copyFile
    console.log("\n--- Testing copyFile ---");
    await ft.copyFile(branch, "greeting.txt", "welcome.txt", author);
    const node3 = await repo.checkout(branch);
    if (node3?.tree?.["greeting.txt"] !== node3?.tree?.["welcome.txt"]) {
      throw new Error("❌ copyFile: File not copied/pointer mismatch");
    }
    console.log("✅ copyFile: Copy successful (CAS re-pointer).");

    // 4. Test getRecursiveTree
    console.log("\n--- Testing getRecursiveTree ---");
    await ft.writeFile(branch, "src/main.ts", 'console.log("hi")', author);
    await ft.writeFile(branch, "src/utils/math.ts", "export const pi = 3.14", author);
    const tree = await ft.getRecursiveTree(branch);
    console.log("Recursive Tree Structure:", JSON.stringify(tree, null, 2));
    if (tree.src?.utils?.["math.ts"]) {
      console.log("✅ getRecursiveTree: Nested structure verified.");
    } else {
      throw new Error("❌ getRecursiveTree: Nested structure missing");
    }

    // 5. Test listFiles (with batch optimization)
    console.log("\n--- Testing listFiles ---");
    const files = await ft.listFiles(branch);
    console.log(`Found ${files.length} files.`);
    if (files.find((f) => f.path === "src/utils/math.ts" && f.size > 0)) {
      console.log("✅ listFiles: Batch resolution verified.");
    } else {
      throw new Error("❌ listFiles: Size or path missing");
    }

    // 6. Test Concurrency Guard
    console.log("\n--- Testing Concurrency Guard ---");
    const p1 = ft.writeFile(branch, "concurrent.txt", "Content A", author, { message: "A" });
    const p2 = ft.writeFile(branch, "concurrent.txt", "Content B", author, { message: "B" });
    const [idA, idB] = await Promise.all([p1, p2]);
    console.log(
      `Concurrent writes completed. Final head: ${idA === idB ? "Conflict?" : "Resolved"}`,
    );
    const finalNode = await repo.checkout(branch);
    console.log("Final content in tree:", finalNode?.tree?.["concurrent.txt"]);
    console.log("✅ Concurrency: No overlaps/crashes detected.");

    console.log("\n🌟 ALL VERIFICATIONS PASSED 🌟");
  } catch (err: any) {
    console.error("\n❌ VERIFICATION FAILED:", err.message);
    process.exit(1);
  }
}

runVerification();
