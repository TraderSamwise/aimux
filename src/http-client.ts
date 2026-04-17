import http from "node:http";
import https from "node:https";

export interface HttpJsonResponse<T = any> {
  status: number;
  json: T;
}

export async function requestJson<T = any>(
  urlString: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<HttpJsonResponse<T>> {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;
  const bodyString =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };
  if (bodyString !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  if (bodyString !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = Buffer.byteLength(bodyString).toString();
  }

  return await new Promise<HttpJsonResponse<T>>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? (bodyString === undefined ? "GET" : "POST"),
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          let json: T;
          try {
            json = raw ? (JSON.parse(raw) as T) : ({} as T);
          } catch (error) {
            reject(error);
            return;
          }
          resolve({
            status: res.statusCode ?? 0,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 0, () => {
      req.destroy(new Error(`request timed out after ${options.timeoutMs ?? 0}ms`));
    });
    if (bodyString !== undefined) {
      req.write(bodyString);
    }
    req.end();
  });
}
