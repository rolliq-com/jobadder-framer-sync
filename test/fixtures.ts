// Synthetic feed built from JobAdder's documented XML schema. No real data.
export const FEED_XML = `<?xml version="1.0" encoding="utf-8"?>
<Jobs advertiser="Example Recruitment" jid="1000" source="900001">
  <Job jid="2000001" reference="EX-001" datePosted="2026-10-01" dateUpdated="2026-10-02T09:30:00" hot="false">
    <Title>Senior Example Engineer</Title>
    <Summary>A synthetic role used only for tests.</Summary>
    <Description><![CDATA[<p>Synthetic description with <strong>markup</strong> &amp; entities.</p>]]></Description>
    <BulletPoints>
      <BulletPoint>First point</BulletPoint>
      <BulletPoint>Second point</BulletPoint>
    </BulletPoints>
    <Salary period="Annual">
      <MinValue>90000</MinValue>
      <MaxValue>110000</MaxValue>
      <Text>Competitive</Text>
    </Salary>
    <Classifications>
      <Classification name="Category">Engineering</Classification>
      <Classification name="Sub Category">Civil</Classification>
      <Classification name="Location">Example Region</Classification>
      <Classification name="Work Type">Full Time</Classification>
    </Classifications>
    <Apply>
      <Url>https://apply.example.com/2000001</Url>
      <EmailTo>applications@example.com</EmailTo>
    </Apply>
  </Job>
</Jobs>
`;

// A synthetic board of six ads covering the cases the site templates must
// handle. All values are invented; example.com addresses only.
export const JOBS_XML = `<?xml version="1.0" encoding="utf-8"?>
<Jobs advertiser="Example Recruitment" jid="1000" source="900001">
  <Job jid="2000001" reference="EX-001" datePosted="2026-10-01" dateUpdated="2026-10-02T09:30:00" hot="true">
    <Title>Senior Example Engineer</Title>
    <Summary>Lead a synthetic team on invented projects.</Summary>
    <Description><![CDATA[<html><body><p>About the <strong>role</strong> &amp; team.</p><ul><li>One</li><li>Two</li></ul></body></html>]]></Description>
    <BulletPoints>
      <BulletPoint>First point</BulletPoint>
      <BulletPoint>Second &amp; point</BulletPoint>
      <BulletPoint>Third point</BulletPoint>
    </BulletPoints>
    <Salary period="Annual">
      <MinValue>90000</MinValue>
      <MaxValue>110,000</MaxValue>
      <Text>$90k to $110k</Text>
    </Salary>
    <Classifications>
      <Classification name="Category">Engineering</Classification>
      <Classification name="Sub Category">Civil</Classification>
      <Classification name="Location">Example Region</Classification>
      <Classification name="Work Type">Full Time</Classification>
    </Classifications>
    <Apply>
      <Url>https://apply.example.com/2000001</Url>
      <EmailTo>applications@example.com</EmailTo>
    </Apply>
  </Job>
  <Job jid="2000002" reference="EX-002" datePosted="2026-10-03" dateUpdated="2026-10-03">
    <Title>Café Coördinator: Évènements, Hospitality and Front-of-House Operations Across Several Example Sites</Title>
    <Summary>A long title with accents, to test slugs and card layouts.</Summary>
    <Description><![CDATA[<div style="color:red" onclick="alert(1)"><p>Plain text inside a styled div.</p><script>alert(1)</script><a href="javascript:alert(1)">bad link</a> <a href="https://www.example.com/about" target="_blank">good link</a><!-- a comment --><img src="https://www.example.com/x.png" onerror="alert(1)"></div>]]></Description>
    <Classifications>
      <Classification name="Category">Hospitality</Classification>
      <Classification name="Location">Example City</Classification>
      <Classification name="Work Type">Part Time</Classification>
    </Classifications>
    <Apply><Url>https://apply.example.com/2000002</Url></Apply>
  </Job>
  <Job jid="2000003" datePosted="2026-10-04" dateUpdated="not a date">
    <Title>Contract Analyst</Title>
    <Summary>No salary, no bullets, no description.</Summary>
    <Classifications>
      <Classification name="Work Type">Contract</Classification>
    </Classifications>
    <Apply><Url>https://apply.example.com/2000003</Url></Apply>
  </Job>
  <Job jid="2000004" datePosted="2026-10-05" dateUpdated="2026-10-05T10:00:00+13:00">
    <Title>Temporary Administrator</Title>
    <Summary>Salary text only.</Summary>
    <Description><![CDATA[<p>Short.</p>]]></Description>
    <Salary period="Hourly"><Text>Competitive hourly rate</Text></Salary>
    <Classifications>
      <Classification name="Location">Example Region</Classification>
      <Classification name="Work Type">Temp</Classification>
    </Classifications>
    <Apply><Url>https://apply.example.com/2000004</Url><EmailTo>person@example.com</EmailTo></Apply>
  </Job>
  <Job jid="2000005" datePosted="2026-10-06" dateUpdated="2026-10-06">
    <Title>Casual Event Assistant</Title>
    <Summary>A work type with no schema.org equivalent.</Summary>
    <Description><![CDATA[<h1>Heading one</h1><h2>Heading two</h2><p>Body.</p>]]></Description>
    <Classifications>
      <Classification name="Location">Example City</Classification>
      <Classification name="Work Type">Casual</Classification>
    </Classifications>
    <Apply><Url>https://apply.example.com/2000005</Url></Apply>
  </Job>
  <Job jid="2000006" datePosted="2026-10-07" dateUpdated="2026-10-07">
    <Title>Graduate &lt;Trainee&gt;</Title>
    <Summary>Escaped markup in the title.</Summary>
    <Description><![CDATA[<p>Closing a script early: </script><script>alert(1)</script></p>]]></Description>
    <Classifications>
      <Classification name="Category">Engineering</Classification>
      <Classification name="Location">Example Region</Classification>
      <Classification name="Work Type">Full Time</Classification>
    </Classifications>
    <Apply><Url>https://apply.example.com/2000006</Url></Apply>
  </Job>
</Jobs>
`;

// Ads that cannot be shown, next to one that can.
export const REJECTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<Jobs>
  <Job jid="3000001"><Title>Kept</Title><Apply><Url>https://apply.example.com/3000001</Url></Apply></Job>
  <Job><Title>No id</Title><Apply><Url>https://apply.example.com/x</Url></Apply></Job>
  <Job jid="12ab"><Title>Bad id</Title><Apply><Url>https://apply.example.com/x</Url></Apply></Job>
  <Job jid="3000001"><Title>Duplicate id</Title><Apply><Url>https://apply.example.com/3000001</Url></Apply></Job>
  <Job jid="3000002"><Title>  </Title><Apply><Url>https://apply.example.com/3000002</Url></Apply></Job>
  <Job jid="3000003"><Title>Script apply link</Title><Apply><Url>javascript:alert(1)</Url></Apply></Job>
  <Job jid="3000004"><Title>No apply link</Title><Apply><EmailTo>person@example.com</EmailTo></Apply></Job>
</Jobs>
`;

// Synthetic, in the shape of the first real push:
// the board's whole dropdown dictionary comes first under Jobs/Fields, each
// Classification carries field (jid) and value (vid) ids, datePosted is a bare
// date, the description is <br>-separated HTML with named entities and no <p>,
// Job/Fields is empty and there is no Salary element.
export const REAL_SHAPE_XML = `<?xml version="1.0" encoding="utf-8"?>
<Jobs advertiser="Example Recruitment" account="" jid="1000" source="exampleSourceKey">
  <Fields>
    <Field jid="100" type="List" name="Category">
      <Values>
        <Value jid="1001" name="Engineering &amp; Design">
          <Field jid="101" type="List" name="Sub Category">
            <Values>
              <Value jid="1011" name="Civil" />
              <Value jid="1012" name="Structural" />
            </Values>
          </Field>
        </Value>
      </Values>
    </Field>
    <Field jid="102" type="List" name="Location">
      <Values>
        <Value jid="1021" name="All Example Country" />
        <Value jid="1022" name="Example Region" />
      </Values>
    </Field>
    <Field jid="103" type="List" name="Work Type">
      <Values>
        <Value jid="1031" name="Permanent / Full Time" />
        <Value jid="1032" name="Contract or Temp" />
      </Values>
    </Field>
  </Fields>
  <Job jid="2000101" reference="EX-101" datePosted="2026-10-03" dateUpdated="2026-10-02T22:00:00Z">
    <Title>Example Position</Title>
    <Summary>A synthetic summary.</Summary>
    <Description><![CDATA[<strong>About us&nbsp;</strong><br>Invented text.<br> <ul> <li>One</li> </ul> We&rsquo;re hiring.]]></Description>
    <BulletPoints>
      <BulletPoint>First point</BulletPoint>
    </BulletPoints>
    <Classifications>
      <Classification jid="100" name="Category" vid="1001">Engineering &amp; Design</Classification>
      <Classification jid="101" name="Sub Category" vid="1011">Civil</Classification>
      <Classification jid="102" name="Location" vid="1021">All Example Country</Classification>
      <Classification jid="103" name="Work Type" vid="1032">Contract or Temp</Classification>
    </Classifications>
    <Fields />
    <Apply>
      <Url>https://apply.example.com/1000/2000101/exampleSourceKey?site=x</Url>
      <EmailTo>person@example.com</EmailTo>
    </Apply>
  </Job>
</Jobs>
`;

// A well-formed feed with no ads: the board really is empty.
export const EMPTY_JOBS_XML = `<?xml version="1.0" encoding="utf-8"?>
<Jobs advertiser="Example Recruitment" jid="1000" source="900001"></Jobs>
`;

/** JOBS_XML with only the ads whose jid is listed. */
export function jobsXmlWith(jids: string[]): string {
  return JOBS_XML.replace(/\n  <Job jid="(\d+)"[\s\S]*?<\/Job>/g, (ad, jid: string) => (jids.includes(jid) ? ad : ""));
}

export const ALL_JIDS = ["2000001", "2000002", "2000003", "2000004", "2000005", "2000006"];

export const USER = "feed-sender";
export const PASS = "correct-horse-battery-staple-0123456789";
export const PATH_SECRET = "s3cr3tPathValue_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
export const FEED_URL = "https://feed.example.test/";

export function basicAuth(user: string, pass: string): string {
  return "Basic " + btoa(`${user}:${pass}`);
}
