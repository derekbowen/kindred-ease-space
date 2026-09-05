# EmailIt docs extracts used by dns-state.md (fetched 2026-09-05 ~06:00 UTC)

## https://emailit.com/docs/guides/creating-a-domain/

 Domains
 Domains are used to send emails from your own domain. To send emails using Emailit, you need to create a domain and add DNS records to your domain.
 In Emailit, you can create multiple domains in any format, including subdomains.
 Examples of valid domains:
 example.com 
 subdomain.example.com 
 subdomain.subdomain.example.com 
 Creating a domain
 To create a domain in Emailit, you can do it using the dashboard or the API.
 Using the dashboard
 Go to the Emailit dashboard .
 Click on the Domains tab.
 Click on the Add Domain button.
 Fill in the required information and click on the Add button.
 Using the API
 You can create a domain using the API by sending a POST request to the /domains endpoint.
 POST 
 Create a domain 
 Create a domain in Emailit. 
## Adding DNS records
 To send emails using your domain, you need to add DNS records to your domain. Those records are shown on the page after you create a domain.
 In your DNS provider
 Add a TXT record for DKIM verification.
 Add a TXT record for SPF verification.
 Add a MX record for email feedback.
 (Optional) Add a DMARC record for email authentication.
 All these records are setup on a subdomain of the chosen domain. For example, if you choose mail.example.com as your domain, you need to add the records to emailit.mail.example.com .
 This allows you to use the subdomain to send emails, while the root domain is used for verification and you can use it for other purposes.
 Checking your records
 After you add the records, you need to wait for them to be verified. You can check the verification status on the domain page by clicking on the “Check DNS” button. It checks all the records and shows the results. It can take up to 24 hours for the records to be verified.
 Previous Introduction 

## https://emailit.com/docs/guides/sending-using-smtp/ (From-domain rule)

 From: Any Name <{any_address}@{verified_sending_domain}> for example John Doe <john@doe.com> 
 You also need to use the verified sending domain, otherwise the email will not be accepted.
 Previous How to Get an API Key 
 Next Emailit MCP Server 

## https://emailit.com/docs/api-reference/domains/get/ — sample domain object with dns_records (verbatim from the page)

```json
{
 "object": "domain",
 "id": 1234567890,
 "uuid": "sd_1234567890",
 "name": "mail.yourdomain.com",
 "verification_token": "abc123def456",
 "verification_method": "dns",
 "verified_at": null,
 "dkim_identifier_string": "emailit._domainkey",
 "dns_checked_at": "2021-01-01T12:00:00Z",
 "spf_status": "failed",
 "spf_error": "SPF record not found",
 "dkim_status": "failed",
 "dkim_error": "DKIM record not found",
 "mx_status": "ok",
 "mx_error": null,
 "return_path_status": "ok",
 "return_path_error": null,
 "dmarc_status": "pending",
 "dmarc_error": null,
 "tracking_status": "missing",
 "tracking_error": "There are no CNAME records at tr.yourdomain.com",
 "inbound_status": "missing",
 "inbound_error": "There are no MX records at inbound.yourdomain.com",
 "track_loads": 0,
 "track_clicks": 0,
 "dns_records": [
 {
 "required": true,
 "type": "MX",
 "name": "mail.yourdomain.com",
 "ttl": "auto",
 "status": "ok",
 "value": "feedback-smtp.ffdc-1.emailit.com",
 "priority": 10,
 "error": null
 },
 {
 "required": true,
 "type": "TXT",
 "name": "mail.yourdomain.com",
 "ttl": "auto",
 "status": "failed",
 "value": "v=spf1 include:_spf.emailit.com ~all",
 "priority": null,
 "error": "SPF record not found"
 },
 {
 "required": true,
 "type": "TXT",
 "name": "emailit._domainkey.yourdomain.com",
 "ttl": "auto",
 "status": "failed",
 "value": "v=DKIM1; t=s; h=sha256; p=MIGfMA....",
 "priority": null,
 "error": "DKIM record not found"
 },
 {
 "required": false,
 "type": "TXT",
 "name": "_dmarc.yourdomain.com",
 "ttl": "auto",
 "status": "pending",
 "value": "v=DMARC1; p=none;",
 "priority": null,
 "error": null
 },
 {
 "required": false,
 "type": "CNAME",
 "name": "tr.yourdomain.com",
 "ttl": "auto",
 "status": "missing",
 "value": "go.emailitmail.com",
 "priority": null,
 "error": "There are no CNAME records at tr.yourdomain.com"
 },
 {
 "required": false,
 "type": "MX",
 "name": "inbound.yourdomain.com",
 "ttl": "auto",
 "status": "missing",
 "value": "inbound.emailitmail.com",
 "priority": 10,
 "error": "There are no MX records at inbound.yourdomain.com"
 }
 ],
 "created_at": "2021-01-01T00:00:00Z",
 "updated_at": "2021-01-01T12:00:00Z"
}
```

Verification semantics (verbatim): n/a

## https://emailit.com/docs/api-reference/emails/send/ — unverified-domain error sample (verbatim)

From/Sender domain is not valid or not verified " , "details" : " The domain from email address 'sender@unverified.com' is not verified in your workspace " } { "error" : " Rate limit exceeded " , "message" : " Too many requests. Maximum 10 messages per second allowed. " , "limit" : 10 , "current" : 11 , "retry_after" : 1 } List Emails 
