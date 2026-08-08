import { describe, expect, it } from "vitest";
import policy from "../../config/csp-policy.json";

describe("CSP policy safety floor", () => {
  it("keeps script and style element sources free of broad inline/eval tokens", () => {
    expect(policy.directives["script-src"]).toEqual(["'self'"]);
    expect(policy.directives["style-src-elem"]).toEqual(["'self'"]);
    expect(policy.directives["worker-src"]).toEqual(["'self'"]);
    expect(policy.directives["connect-src"]).toEqual(["'self'"]);
    expect(policy.directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(policy.directives["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("forbids inline style attributes after the P8 migration", () => {
    expect(policy.directives["style-src-attr"]).toEqual(["'none'"]);
    expect(policy.directives["style-src-attr"]).not.toContain(
      "'unsafe-inline'",
    );
    expect(policy.temporaryExceptions).toEqual([]);
  });

  it("keeps reporting same-origin and includes the required security headers", () => {
    expect(policy.reportEndpoint).toBe("/api/csp-report");
    expect(policy.directives["report-uri"]).toEqual(["/api/csp-report"]);
    expect(policy.securityHeaders).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });
});
