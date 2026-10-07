// Friendly category names → OpenStreetMap tags.
// In config.js you can also use any raw tag directly, e.g. 'shop=bicycle'.

export const CATEGORIES = {
  restaurant: { label: 'Restaurant', tags: ['amenity=restaurant'] },
  cafe: { label: 'Café', tags: ['amenity=cafe'] },
  fast_food: { label: 'Fast food', tags: ['amenity=fast_food'] },
  bakery: { label: 'Bakery / sweets', tags: ['shop=bakery', 'shop=confectionery', 'shop=pastry'] },
  salon: { label: 'Salon / beauty', tags: ['shop=hairdresser', 'shop=beauty'] },
  dentist: { label: 'Dentist', tags: ['amenity=dentist', 'healthcare=dentist'] },
  clinic: { label: 'Clinic / doctor', tags: ['amenity=clinic', 'amenity=doctors', 'healthcare=clinic', 'healthcare=doctor'] },
  pharmacy: { label: 'Pharmacy', tags: ['amenity=pharmacy'] },
  gym: { label: 'Gym', tags: ['leisure=fitness_centre'] },
  car_repair: { label: 'Car repair', tags: ['shop=car_repair', 'shop=tyres'] },
  car_dealer: { label: 'Car dealer', tags: ['shop=car'] },
  motorcycle: { label: 'Motorcycle shop', tags: ['shop=motorcycle', 'shop=motorcycle_repair'] },
  clothes: { label: 'Clothes / tailor', tags: ['shop=clothes', 'shop=boutique', 'shop=fabric', 'shop=tailor', 'craft=tailor'] },
  shoes: { label: 'Shoes', tags: ['shop=shoes'] },
  jewelry: { label: 'Jewellery', tags: ['shop=jewelry'] },
  electronics: { label: 'Electronics / mobiles', tags: ['shop=electronics', 'shop=mobile_phone', 'shop=computer'] },
  furniture: { label: 'Furniture', tags: ['shop=furniture', 'shop=interior_decoration'] },
  hardware: { label: 'Hardware', tags: ['shop=hardware', 'shop=doityourself'] },
  grocery: { label: 'Grocery', tags: ['shop=supermarket', 'shop=convenience', 'shop=greengrocer'] },
  butcher: { label: 'Butcher', tags: ['shop=butcher'] },
  optician: { label: 'Optician', tags: ['shop=optician'] },
  florist: { label: 'Florist', tags: ['shop=florist'] },
  hotel: { label: 'Hotel / guest house', tags: ['tourism=hotel', 'tourism=guest_house', 'tourism=motel'] },
  real_estate: { label: 'Real estate agent', tags: ['office=estate_agent'] },
  lawyer: { label: 'Lawyer', tags: ['office=lawyer'] },
  accountant: { label: 'Accountant', tags: ['office=accountant', 'office=tax_advisor'] },
  travel_agency: { label: 'Travel agency', tags: ['shop=travel_agency', 'office=travel_agent'] },
  vet: { label: 'Vet', tags: ['amenity=veterinary'] },
  laundry: { label: 'Laundry / dry cleaning', tags: ['shop=laundry', 'shop=dry_cleaning'] },
  printing: { label: 'Printing', tags: ['shop=copyshop', 'craft=printer'] },
  photographer: { label: 'Photographer', tags: ['craft=photographer', 'shop=photo'] },
  pet_shop: { label: 'Pet shop', tags: ['shop=pet'] },
  books: { label: 'Books / stationery', tags: ['shop=books', 'shop=stationery'] },
  driving_school: { label: 'Driving school', tags: ['amenity=driving_school'] },
  plumber: { label: 'Plumber', tags: ['craft=plumber'] },
  electrician: { label: 'Electrician', tags: ['craft=electrician'] },
  hvac: { label: 'HVAC / air conditioning', tags: ['craft=hvac'] },
  roofer: { label: 'Roofer', tags: ['craft=roofer'] },
  painter: { label: 'Painter / decorator', tags: ['craft=painter'] },
  locksmith: { label: 'Locksmith', tags: ['shop=locksmith', 'craft=locksmith'] },
  carpenter: { label: 'Carpenter', tags: ['craft=carpenter'] },
  cleaning: { label: 'Cleaning service', tags: ['craft=cleaning', 'office=cleaning'] },
  landscaping: { label: 'Landscaping / gardening', tags: ['craft=gardener'] },
};

// What to type into Google Maps for each category ("plumbers in Jackson, Mississippi").
// Used when OpenStreetMap doesn't have enough of them; mostly the case for trades in the US.
export const MAPS_SEARCH = {
  restaurant: 'restaurants', cafe: 'cafes', fast_food: 'fast food', bakery: 'bakeries', salon: 'beauty salons',
  dentist: 'dentists', clinic: 'medical clinics', pharmacy: 'pharmacies', gym: 'gyms', car_repair: 'auto repair shops',
  car_dealer: 'car dealers', motorcycle: 'motorcycle shops', clothes: 'clothing stores', shoes: 'shoe stores',
  jewelry: 'jewelry stores', electronics: 'electronics stores', furniture: 'furniture stores', hardware: 'hardware stores',
  grocery: 'grocery stores', butcher: 'butcher shops', optician: 'opticians', florist: 'florists', hotel: 'hotels',
  real_estate: 'real estate agents', lawyer: 'lawyers', accountant: 'accountants', travel_agency: 'travel agencies',
  vet: 'veterinarians', laundry: 'laundry services', printing: 'printing services', photographer: 'photographers',
  pet_shop: 'pet stores', books: 'bookstores', driving_school: 'driving schools', plumber: 'plumbers',
  electrician: 'electricians', hvac: 'hvac contractors', roofer: 'roofing contractors', painter: 'painters',
  locksmith: 'locksmiths', carpenter: 'carpenters', cleaning: 'cleaning services', landscaping: 'landscapers',
};

function parseTag(text) {
  const i = text.indexOf('=');
  return { key: text.slice(0, i).trim(), value: text.slice(i + 1).trim() };
}

/** Turns config categories into { id, label, tags: [{key, value}] }, reporting unknown names. */
export function resolveCategories(list) {
  const defs = [];
  const unknown = [];
  for (const raw of Array.isArray(list) ? list : [list]) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const known = CATEGORIES[id.toLowerCase()];
    if (known) defs.push({ id: id.toLowerCase(), label: known.label, tags: known.tags.map(parseTag), search: MAPS_SEARCH[id.toLowerCase()] });
    else if (/^[\w:-]+=[^=]+$/.test(id)) defs.push({ id, label: id, tags: [parseTag(id)], search: parseTag(id).value.replace(/_/g, ' ') });
    else unknown.push(id);
  }
  return { defs, unknown };
}
