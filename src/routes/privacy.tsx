import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout } from "@/components/LegalLayout";
import { canonicalUrl } from "@/lib/canonical";

const EFFECTIVE = "May 11, 2026";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — founders.click" },
      { name: "description", content: "How 10000 Solutions LLC collects, uses, and protects your information on founders.click." },
      { property: "og:title", content: "Privacy Policy — founders.click" },
      { property: "og:description", content: "How 10000 Solutions LLC collects, uses, and protects your information on founders.click." },
      { property: "og:url", content: canonicalUrl("/privacy") },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/privacy") }],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" effectiveDate={EFFECTIVE}>
      <p>
        This Privacy Policy explains how <strong>10000 Solutions LLC</strong>, a
        California limited liability company ("<strong>10000 Solutions</strong>",
        "<strong>we</strong>", "<strong>us</strong>", or "<strong>our</strong>"),
        collects, uses, discloses, and protects information when you visit
        founders.click, use our applications, APIs, or related services (collectively,
        the "<strong>Service</strong>"). By using the Service you agree to this
        Policy. If you do not agree, do not use the Service.
      </p>

      <h2>1. Information We Collect</h2>
      <h3>1.1 Information you provide</h3>
      <ul>
        <li><strong>Account information:</strong> name, email, password, organization, role, and profile details.</li>
        <li><strong>Billing information:</strong> billing name, address, tax ID, and payment method (processed by our payment processor; we do not store full card numbers).</li>
        <li><strong>Content:</strong> data, files, prompts, articles, listings, and other content you submit through the Service ("<strong>Customer Data</strong>").</li>
        <li><strong>Communications:</strong> support requests, survey responses, and other messages you send us.</li>
      </ul>
      <h3>1.2 Information collected automatically</h3>
      <ul>
        <li><strong>Device and log data:</strong> IP address, browser type, operating system, referring URLs, pages viewed, and timestamps.</li>
        <li><strong>Usage data:</strong> features used, actions taken, error reports, and performance metrics.</li>
        <li><strong>Cookies and similar technologies:</strong> see Section 7.</li>
      </ul>
      <h3>1.3 Information from third parties</h3>
      <ul>
        <li><strong>Connected services:</strong> when you link Sharetribe, Stripe, Google, or other accounts, we receive information those providers share, subject to your authorizations.</li>
        <li><strong>Analytics and security providers:</strong> de-identified or aggregated data used to maintain and improve the Service.</li>
      </ul>

      <h2>2. How We Use Information</h2>
      <p>We use information to:</p>
      <ul>
        <li>Provide, maintain, secure, and improve the Service;</li>
        <li>Authenticate you and process transactions;</li>
        <li>Provide customer support and respond to inquiries;</li>
        <li>Send service announcements, security alerts, and administrative messages;</li>
        <li>Send marketing communications where permitted (you can opt out at any time);</li>
        <li>Detect, prevent, and address fraud, abuse, and security incidents;</li>
        <li>Comply with legal obligations and enforce our agreements;</li>
        <li>Analyze usage to develop new features and understand product performance.</li>
      </ul>

      <h2>3. Legal Bases (EEA/UK Users)</h2>
      <p>
        If you are in the European Economic Area or the United Kingdom, we rely on
        the following legal bases: performance of a contract; legitimate interests
        (e.g., operating and improving the Service, security, and direct marketing
        to existing customers); compliance with legal obligations; and your consent
        where required (e.g., certain cookies and marketing emails).
      </p>

      <h2>4. How We Share Information</h2>
      <p>We share information only as described below:</p>
      <ul>
        <li><strong>Service providers / sub-processors:</strong> hosting, database, email, analytics, AI, error monitoring, and payment processors that act on our instructions under written contracts (e.g., Supabase, Cloudflare, Stripe, EmailIt, OpenAI/Lovable AI Gateway).</li>
        <li><strong>Connected services you authorize:</strong> e.g., Sharetribe and other integrations you enable.</li>
        <li><strong>Business transfers:</strong> in connection with a merger, financing, acquisition, or sale of assets, subject to standard confidentiality protections.</li>
        <li><strong>Legal and safety:</strong> to comply with law, respond to lawful requests, enforce our Terms, or protect rights, property, or safety.</li>
        <li><strong>With your consent or at your direction.</strong></li>
      </ul>
      <p><strong>We do not sell your personal information for money.</strong> See Section 9 regarding "sale" or "share" as those terms are defined under California law.</p>

      <h2>5. Customer Data</h2>
      <p>
        For Customer Data uploaded by our business customers, we act as a processor or
        service provider on behalf of the customer. We process Customer Data only to
        provide the Service, comply with law, and as instructed by the customer. End
        users should direct privacy requests about Customer Data to the customer
        (controller) first.
      </p>

      <h2>6. Data Retention</h2>
      <p>
        We retain personal information only as long as needed to provide the Service,
        comply with legal obligations, resolve disputes, and enforce our agreements.
        When no longer needed, we delete or anonymize it. Backup copies may persist
        for a limited additional period.
      </p>

      <h2>7. Cookies and Tracking</h2>
      <p>
        We use cookies and similar technologies to keep you signed in, remember
        preferences, measure performance, and improve the Service. You can control
        cookies through your browser settings. Disabling some cookies may affect
        functionality. Where required, we will request your consent before placing
        non-essential cookies.
      </p>

      <h2>8. Security</h2>
      <p>
        We use administrative, technical, and physical safeguards designed to protect
        information, including encryption in transit, access controls, and monitoring.
        No method of transmission or storage is 100% secure, and we cannot guarantee
        absolute security. Notify us immediately at{" "}
        <a href="mailto:support@founders.click">support@founders.click</a> if you
        believe your account has been compromised.
      </p>

      <h2>9. Your U.S. Privacy Rights (California and Other States)</h2>
      <p>
        Depending on your state of residence (e.g., California, Colorado, Connecticut,
        Virginia, Utah, Texas, Oregon), you may have the right to:
      </p>
      <ul>
        <li>Know or access the personal information we hold about you;</li>
        <li>Request correction or deletion;</li>
        <li>Request portability of your information;</li>
        <li>Opt out of "sale" or "sharing" of personal information for cross-context behavioral advertising;</li>
        <li>Limit use of sensitive personal information;</li>
        <li>Appeal our decision regarding your request;</li>
        <li>Not receive discriminatory treatment for exercising your rights.</li>
      </ul>
      <p>
        <strong>California "Shine the Light":</strong> California residents may
        request information about disclosures of personal information to third parties
        for their direct marketing purposes. We do not currently make such
        disclosures.
      </p>
      <p>
        To exercise any of these rights, email{" "}
        <a href="mailto:support@founders.click">support@founders.click</a> from the
        email address associated with your account, or include sufficient information
        for us to verify your identity. You may use an authorized agent; we will
        require proof of authorization. We will respond within the period required by
        applicable law.
      </p>
      <p>
        <strong>Notice of collection (California):</strong> in the past 12 months we
        have collected the categories of personal information described in Section 1
        for the purposes described in Section 2, and disclosed those categories to the
        recipients described in Section 4. We have not knowingly sold personal
        information for monetary consideration.
      </p>

      <h2>10. EEA, UK, and Swiss Users</h2>
      <p>
        You may have the right to access, rectify, erase, restrict, or object to our
        processing of your personal information, and to data portability. You may also
        lodge a complaint with your supervisory authority. Where we transfer personal
        data outside the EEA, UK, or Switzerland, we use lawful transfer mechanisms
        such as the European Commission's Standard Contractual Clauses.
      </p>

      <h2>11. Children's Privacy</h2>
      <p>
        The Service is not directed to children under 16, and we do not knowingly
        collect personal information from children under 16. If you believe a child
        has provided us personal information, contact us and we will take appropriate
        steps to delete it.
      </p>

      <h2>12. Marketing Choices</h2>
      <p>
        You can opt out of promotional emails by clicking the unsubscribe link in any
        such email or by emailing{" "}
        <a href="mailto:support@founders.click">support@founders.click</a>. We may
        still send service-related communications.
      </p>

      <h2>13. Third-Party Sites and Services</h2>
      <p>
        The Service may contain links to or integrate with third-party services. Their
        privacy practices are governed by their own policies. We are not responsible
        for the practices of any third party.
      </p>

      <h2>14. International Users</h2>
      <p>
        We are based in the United States and process information in the United States
        and other countries where our service providers operate. By using the Service
        you understand that your information may be processed in countries with
        different data-protection laws than your own.
      </p>

      <h2>15. Changes to this Policy</h2>
      <p>
        We may update this Policy from time to time. If changes are material, we will
        notify you by email or through the Service before they take effect. The
        "Effective date" above shows when this Policy was last updated.
      </p>

      <h2>16. Contact Us</h2>
      <p>
        Questions, requests, or complaints about this Policy or our privacy practices:
      </p>
      <p>
        10000 Solutions LLC<br />
        Email: <a href="mailto:support@founders.click">support@founders.click</a>
      </p>
    </LegalLayout>
  );
}
