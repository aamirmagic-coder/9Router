import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));

export function loadEnvFileIntoProcess(filePath = repositoryEnvPath) {
  try {
    loadEnvFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

loadEnvFileIntoProcess();
