import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout } from "@/components/LegalLayout";
import { canonicalUrl } from "@/lib/canonical";

const EFFECTIVE = "May 11, 2026";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — founders.click" },
      { name: "description", content: "Terms of Service for founders.click, a product of 10000 Solutions LLC." },
      { property: "og:title", content: "Terms of Service — founders.click" },
      { property: "og:description", content: "Terms of Service for founders.click, a product of 10000 Solutions LLC." },
      { property: "og:url", content: canonicalUrl("/terms") },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/terms") }],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" effectiveDate={EFFECTIVE}>
      <p>
        These Terms of Service (the "<strong>Terms</strong>") form a binding legal
        agreement between you ("<strong>you</strong>", "<strong>your</strong>", or the
        "<strong>Customer</strong>") and <strong>10000 Solutions LLC</strong>, a
        California limited liability company ("<strong>10000 Solutions</strong>",
        "<strong>we</strong>", "<strong>us</strong>", or "<strong>our</strong>"),
        governing your access to and use of the founders.click website, applications,
        APIs, and related services (collectively, the "<strong>Service</strong>"). By
        creating an account, accessing, or using the Service, you agree to be bound by
        these Terms. If you do not agree, do not use the Service.
      </p>

      <p>
        <strong>
          These Terms contain a binding individual arbitration clause and class action
          waiver in Section 16. Please read them carefully.
        </strong>
      </p>

      <h2>1. Eligibility and Accounts</h2>
      <p>
        You must be at least 18 years old and capable of forming a binding contract to
        use the Service. If you are using the Service on behalf of an organization,
        you represent that you have authority to bind that organization, in which case
        "you" refers to both you and that organization.
      </p>
      <p>
        You are responsible for maintaining the confidentiality of your account
        credentials and for all activity that occurs under your account. You agree to
        notify us promptly at <a href="mailto:support@founders.click">support@founders.click</a>{" "}
        if you suspect unauthorized access. We may suspend or terminate accounts that
        we reasonably believe are being misused.
      </p>

      <h2>2. The Service</h2>
      <p>
        The Service provides tools, content, and integrations for marketplace
        operators (including, where enabled, integrations with Sharetribe and other
        third-party platforms). We may add, modify, or remove features at any time. We
        will use commercially reasonable efforts to keep the Service available, but we
        do not guarantee uninterrupted or error-free operation.
      </p>

      <h2>3. Plans, Fees, and Billing</h2>
      <p>
        Some features require a paid subscription. Fees, billing cycles, and included
        usage are described at the point of purchase. Unless stated otherwise:
      </p>
      <ul>
        <li>Subscriptions automatically renew at the end of each billing period until cancelled.</li>
        <li>You authorize us (and our payment processor, currently Stripe) to charge your payment method for all applicable fees and taxes.</li>
        <li>Fees are non-refundable except where required by law or expressly stated otherwise.</li>
        <li>We may change pricing on at least 30 days' notice; changes take effect at your next renewal.</li>
        <li>Overdue amounts may incur interest at the lesser of 1.5% per month or the maximum rate permitted by law.</li>
      </ul>
      <p>
        Free trials, credits, and promotional offers may be modified or revoked at any
        time at our discretion.
      </p>

      <h2>4. Customer Data and License to Us</h2>
      <p>
        "<strong>Customer Data</strong>" means content, data, and materials that you
        or your end users submit, upload, or generate through the Service. As between
        you and us, you retain all rights in Customer Data. You grant us a worldwide,
        non-exclusive, royalty-free license to host, process, transmit, display, and
        otherwise use Customer Data solely to operate, secure, support, and improve
        the Service and to comply with law. You represent that you have all necessary
        rights and permissions to provide the Customer Data and that it does not
        violate these Terms or any third-party rights.
      </p>

      <h2>5. Acceptable Use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service in violation of any law or regulation;</li>
        <li>Upload malware or attempt to disrupt, probe, or reverse engineer the Service;</li>
        <li>Resell, sublicense, or provide the Service to third parties except as expressly permitted;</li>
        <li>Send spam, deceptive content, or unsolicited communications using the Service;</li>
        <li>Harvest data about other users or scrape the Service without our written consent;</li>
        <li>Use the Service to infringe intellectual property, privacy, or publicity rights;</li>
        <li>Bypass usage limits, authentication mechanisms, or security features.</li>
      </ul>
      <p>
        We may investigate suspected violations and may suspend or terminate access to
        protect the Service or its users.
      </p>

      <h2>6. AI Features and Generated Output</h2>
      <p>
        The Service may include features that use artificial intelligence to generate
        text, images, code, or other output ("<strong>Output</strong>") based on your
        inputs. You are responsible for reviewing Output before relying on or
        publishing it. Output may be inaccurate, incomplete, or unsuitable for your
        purpose, and similar Output may be generated for other users. You are
        responsible for ensuring your use of Output complies with applicable law,
        including intellectual property and disclosure requirements.
      </p>

      <h2>7. Third-Party Services and Integrations</h2>
      <p>
        The Service may interoperate with third-party services (e.g., Sharetribe,
        Stripe, email providers, search engines, hosting providers). Your use of those
        services is governed by their own terms and privacy policies. We are not
        responsible for third-party services and disclaim liability arising from them.
        If you connect a third-party account, you authorize us to access and exchange
        information with that service on your behalf.
      </p>

      <h2>8. Intellectual Property</h2>
      <p>
        The Service, including its software, designs, trademarks, and content (other
        than Customer Data), is owned by 10000 Solutions or its licensors and is
        protected by intellectual property laws. Subject to your compliance with these
        Terms, we grant you a limited, non-exclusive, non-transferable, revocable
        license to access and use the Service for your internal business purposes. We
        reserve all rights not expressly granted.
      </p>
      <p>
        If you provide feedback or suggestions about the Service, you grant us a
        perpetual, irrevocable, royalty-free license to use them without restriction.
      </p>

      <h2>9. Confidentiality</h2>
      <p>
        Each party may receive non-public information of the other ("<strong>Confidential Information</strong>").
        The receiving party will use Confidential Information only to perform under
        these Terms and will protect it using at least reasonable care. Confidential
        Information does not include information that is or becomes publicly available
        without breach, was already known, was independently developed, or is rightfully
        received from a third party.
      </p>

      <h2>10. Privacy</h2>
      <p>
        Our handling of personal information is described in our{" "}
        <a href="/privacy">Privacy Policy</a>, which is incorporated by reference. If
        you process personal information of EU/UK or California residents through the
        Service, you may also need a data processing addendum; contact{" "}
        <a href="mailto:support@founders.click">support@founders.click</a>.
      </p>

      <h2>11. Term, Suspension, and Termination</h2>
      <p>
        These Terms remain in effect while you use the Service. You may stop using the
        Service and cancel your subscription at any time from your account settings or
        by contacting support. We may suspend or terminate your access immediately if
        you (a) materially breach these Terms, (b) fail to pay amounts when due, (c)
        create risk or possible legal exposure for us, or (d) cease to operate.
      </p>
      <p>
        Upon termination: (i) your right to use the Service ends immediately; (ii) we
        may delete Customer Data after a reasonable period; and (iii) Sections 4 (last
        sentence), 5, 8, 9, 12, 13, 14, 15, 16, and 17 survive.
      </p>

      <h2>12. Disclaimer of Warranties</h2>
      <p>
        <strong>
          THE SERVICE AND OUTPUT ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT
          WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE.
          TO THE FULLEST EXTENT PERMITTED BY LAW, 10000 SOLUTIONS DISCLAIMS ALL
          WARRANTIES, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT, AND ANY WARRANTIES ARISING
          FROM COURSE OF DEALING OR USAGE OF TRADE. WE DO NOT WARRANT THAT THE
          SERVICE WILL BE UNINTERRUPTED, SECURE, OR ERROR-FREE, OR THAT OUTPUT WILL
          BE ACCURATE OR RELIABLE.
        </strong>
      </p>

      <h2>13. Limitation of Liability</h2>
      <p>
        <strong>
          TO THE FULLEST EXTENT PERMITTED BY LAW, 10000 SOLUTIONS AND ITS AFFILIATES,
          OFFICERS, EMPLOYEES, AND AGENTS WILL NOT BE LIABLE FOR ANY INDIRECT,
          INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR
          LOST PROFITS, REVENUE, GOODWILL, OR DATA, ARISING OUT OF OR RELATING TO THE
          SERVICE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
        </strong>
      </p>
      <p>
        <strong>
          OUR TOTAL CUMULATIVE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATING TO
          THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS
          YOU PAID US FOR THE SERVICE IN THE 12 MONTHS BEFORE THE EVENT GIVING RISE
          TO THE CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS (US$100).
        </strong>
      </p>
      <p>
        These limitations apply regardless of the theory of liability and form an
        essential basis of the bargain between you and us. Some jurisdictions do not
        allow the exclusion or limitation of certain damages, so some of the above may
        not apply to you.
      </p>

      <h2>14. Indemnification</h2>
      <p>
        You will defend, indemnify, and hold harmless 10000 Solutions and its
        affiliates, officers, employees, and agents from and against any third-party
        claims, damages, liabilities, costs, and expenses (including reasonable
        attorneys' fees) arising out of or relating to (a) your Customer Data, (b)
        your use of the Service in violation of these Terms or applicable law, or (c)
        your violation of any third-party right.
      </p>

      <h2>15. Governing Law and Venue</h2>
      <p>
        These Terms are governed by the laws of the State of California, without
        regard to its conflict-of-laws principles. Subject to Section 16, the state
        and federal courts located in Los Angeles County, California will have
        exclusive jurisdiction over any disputes not subject to arbitration, and you
        consent to personal jurisdiction and venue there. The U.N. Convention on
        Contracts for the International Sale of Goods does not apply.
      </p>

      <h2>16. Binding Arbitration and Class Action Waiver</h2>
      <p>
        <strong>Please read this section carefully — it affects your legal rights.</strong>
      </p>
      <p>
        You and 10000 Solutions agree that any dispute, claim, or controversy arising
        out of or relating to these Terms or the Service (each, a "<strong>Dispute</strong>")
        will be resolved by binding individual arbitration administered by JAMS under
        its Streamlined Arbitration Rules then in effect. The arbitration will be held
        in Los Angeles County, California, or by video conference, and judgment on the
        award may be entered in any court of competent jurisdiction.
      </p>
      <p>
        <strong>
          You and 10000 Solutions each waive the right to a trial by jury and the
          right to participate in a class, collective, or representative action.
          Disputes must be brought in your or our individual capacity, not as a
          plaintiff or class member in any purported class or representative
          proceeding.
        </strong>{" "}
        If a court decides this class waiver is unenforceable as to any claim, that
        claim must proceed in court and the rest of this Section 16 still applies to
        all other claims.
      </p>
      <p>
        Notwithstanding the above, either party may (a) bring an individual claim in
        small-claims court, and (b) seek injunctive or other equitable relief in a
        court of competent jurisdiction to protect intellectual property or
        confidential information. You may opt out of arbitration within 30 days of
        first accepting these Terms by sending written notice to{" "}
        <a href="mailto:support@founders.click">support@founders.click</a> with the
        subject line "Arbitration Opt-Out" and your account email.
      </p>

      <h2>17. Changes to the Terms</h2>
      <p>
        We may modify these Terms from time to time. If we make material changes, we
        will notify you by email or through the Service at least 14 days before they
        take effect (unless changes are required by law or relate to a new feature, in
        which case they take effect immediately). Your continued use of the Service
        after the effective date constitutes acceptance of the updated Terms.
      </p>

      <h2>18. Miscellaneous</h2>
      <ul>
        <li><strong>Entire agreement.</strong> These Terms, together with the Privacy Policy and any order forms, are the entire agreement between you and us about the Service.</li>
        <li><strong>Assignment.</strong> You may not assign these Terms without our prior written consent. We may assign them in connection with a merger, acquisition, or sale of assets.</li>
        <li><strong>Severability.</strong> If any provision is held unenforceable, the remaining provisions remain in effect.</li>
        <li><strong>No waiver.</strong> Our failure to enforce a right is not a waiver of that right.</li>
        <li><strong>Force majeure.</strong> Neither party is liable for delays or failures caused by events beyond its reasonable control.</li>
        <li><strong>Notices.</strong> We may send notices to the email address on your account. You may send notices to <a href="mailto:support@founders.click">support@founders.click</a>.</li>
        <li><strong>Independent contractors.</strong> The parties are independent contractors; these Terms create no agency, partnership, or joint venture.</li>
        <li><strong>U.S. Government users.</strong> The Service is "commercial computer software" as that term is defined in 48 C.F.R. § 2.101.</li>
        <li><strong>Export.</strong> You will comply with all applicable U.S. and foreign export and sanctions laws.</li>
      </ul>

      <h2>19. Contact</h2>
      <p>
        10000 Solutions LLC<br />
        Email: <a href="mailto:support@founders.click">support@founders.click</a>
      </p>
    </LegalLayout>
  );
}
