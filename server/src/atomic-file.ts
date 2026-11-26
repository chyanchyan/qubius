import fs from "node:fs";
import path from "node:path";

export interface WriteFileAtomicOptions {
  /** 文件权限，默认 0600。 */
  mode?: number;
  /** 覆盖前把当前内容复制到 `${file}.bak`（0600）。 */
  backup?: boolean;
}

const DEFAULT_MODE = 0o600;

let tmpSeq = 0;

function nextTmpSeq(): number {
  tmpSeq += 1;
  return tmpSeq;
}

/**
 * 原子写入：先写同目录临时文件并 fsync，再 rename 覆盖目标，避免中途崩溃留下半截文件。
 * 失败时删除临时文件并抛出，由调用方决定是否降级。
 */
export function writeFileAtomic(
  file: string,
  data: string,
  options: WriteFileAtomicOptions = {},
): void {
  const mode = options.mode ?? DEFAULT_MODE;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  if (options.backup && fs.existsSync(file)) {
    copyFileAtomic(file, `${file}.bak`);
  }

  const tmp = `${file}.tmp.${process.pid}.${nextTmpSeq()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", mode);
    // writeSync 可能只写一部分，循环写满再 fsync。
    const buffer = Buffer.from(data, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error(`写入 ${tmp} 失败：write 没有进展`);
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, mode);
    } catch {
      // 某些文件系统不支持 chmod；权限至少已由 open 时的 mode 指定。
    }
    fsyncDir(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不掩盖原始错误。
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能还没创建成功。
    }
    throw error;
  }
}

/** 复制到备份：先写同目录临时文件再 rename，避免覆盖到一半留下半个 .bak。 */
function copyFileAtomic(source: string, target: string): void {
  const tmp = `${target}.tmp.${process.pid}.${nextTmpSeq()}`;
  try {
    fs.copyFileSync(source, tmp);
    try {
      fs.chmodSync(tmp, DEFAULT_MODE);
    } catch {
      // Windows 等平台 chmod 可能无效；备份仍然只放在 dataDir 里。
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能还没创建成功。
    }
    throw error;
  }
}

/** 尽力把父目录也落盘，让 rename 在掉电后仍然可见；不支持的平台直接忽略。 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Windows 等平台不允许以该方式 fsync 目录，忽略即可。
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略关闭失败。
      }
    }
  }
}
