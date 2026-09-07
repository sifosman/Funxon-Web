export const venueTypes = [
  "Auditoriums",
  "Ballrooms",
  "Banquet halls",
  "Beach venues",
  "Boutiques",
  "Clubhouses",
  "Conference Centres",
  "Convention/Expo Centres",
  "Fairgrounds/Open Fields",
  "Farms",
  "Gardens",
  "Hotels",
  "Industrial venues",
  "Lodges",
  "Resorts",
  "Restaurants",
  "Rooftops",
  "Sports Courts & Arenas",
  "Theatres",
  "Wine estates"
];

export const amenitiesList = [
  "Ablution Facilities",
  "Accommodation / Guest Rooms",
  "Air-conditioning",
  "Ambiant Lighting",
  "Audio Visual Recording Equipment Available",
  "AV Connectivity",
  "Baby Changing Facilities",
  "Balcony / Stoep / Terrace",
  "Bar / Drinks Station",
  "Board Room Table & Chairs",
  "Braai Area",
  "Bridal / Groom Suite",
  "Changing/Cloak Rooms",
  "Chappel",
  "Cleaning Services Available",
  "Cutlery & Crockery Available",
  "Dance floor",
  "Digital White Boards",
  "Flexible with special requests",
  "Free Parking",
  "Full-Service Staffing",
  "Gardens",
  "Gated Access",
  "Generator & Back Up Power",
  "Green Room",
  "Halaal",
  "Heating System",
  "High ceilings",
  "Hybrid Audio Visual Equipment",
  "Indoor & Outdoor Mix Space",
  "Indoor Only Space",
  "Kids Play areas",
  "Kitchen - Basins & Prep Tables",
  "Kitchen - Full Amenities",
  "LED Screen",
  "Linen & Tablecloths Available",
  "Loading / Unloading Area",
  "Lounge & Networking Zones",
  "Marquee / Tent / Gazebo Spaces",
  "Meeting Rooms",
  "Multiple Hall Options at Venue",
  "Natural lighting",
  "Nature Setting",
  "On Site Venue Manager",
  "On-Site Catering",
  "Open Fields",
  "Open indoor/outdoor spaces",
  "Outdoor Only Space",
  "Package Deal Options",
  "Petting Zoo / Animal Park",
  "Pickup/Drop Off Zone",
  "Plug Points / Charging Ports",
  "Podium Available",
  "Projectors",
  "Refrigerator / Cooler Room",
  "Restrooms / Toilets",
  "Salaah Prayer Facilities",
  "Scenic Views",
  "Secure Parking",
  "Security Guards",
  "Sound & Mic system",
  "Stage Available",
  "Storage Space",
  "Swimming Pool",
  "Tables & Chairs Available",
  "Water Features/Fountains",
  "Wheel Chair Accessable",
  "WiFi - high speed"
].sort((a, b) => a.localeCompare(b));

export const venueCapacityOptions = [
  "Under 50",
  "Under 200",
  "Under 500",
  "Under 1000",
  "Under 2000",
  "2000 and More"
];

// Parse the guest number out of any stored capacity label form
// ("Under 1000", "Up to 1000", "2000 and More", "1000", 1000).
export function getCapacityNumber(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (!raw) return null;
  const numbers = String(raw).match(/\d[\d,]*/g);
  if (!numbers || numbers.length === 0) return null;
  const parsed = parseInt(numbers[numbers.length - 1].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Guest-facing wording used consistently across portfolio, search and filters.
// "Under 1000" and "Up to 1000" both display as "Up to 1000 guests";
// "2000 and More" displays as "2000+ guests". Never produces "Up to Under ...".
export function formatVenueCapacity(raw: string | number | null | undefined): string | null {
  const n = getCapacityNumber(raw);
  if (n == null) return null;
  if (/more|\+/i.test(String(raw ?? ''))) return `${n}+ guests`;
  return `Up to ${n} guests`;
}

// Short form for dropdown options / filter chips (no "guests" suffix).
export function formatCapacityOption(raw: string): string {
  const n = getCapacityNumber(raw);
  if (n == null) return raw;
  if (/more|\+/i.test(raw)) return `${n}+`;
  return `Up to ${n}`;
}

export const eventTypes = [
  "Anniversary",
  "Baby Shower",
  "Birthday - Adult",
  "Birthday - Kiddies",
  "Bridal Shower",
  "Community Fair",
  "Conference / Seminar",
  "Corporate Party",
  "Cultural Celebration",
  "Expo",
  "Festival",
  "Fundraiser",
  "Graduation/Awards",
  "Live Show/Concert",
  "Market",
  "Product Launch",
  "Reunion",
  "Sports Tournament",
  "Teambuilding",
  "Wedding"
].sort((a, b) => a.localeCompare(b));
