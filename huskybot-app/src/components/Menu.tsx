import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Define types based on the expected API response from the blueplate library
interface Meal {
  name: string;
  stations: {
    name: string;
    options: string[];
  }[];
}

interface MenuData {
  name: string;
  lateNight: boolean;
  status: string;
  meals: Meal[];
}

interface Hours {
  start: string;
  end: string;
  days: number[];
}

interface DiningHallHours {
  BREAKFAST: Hours[];
  LUNCH: Hours[];
  BRUNCH: Hours[];
  DINNER: Hours[];
  LATE_NIGHT: Hours[];
}

const DiningHallMenu: React.FC = () => {
  const [selectedHall, setSelectedHall] = useState('South');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedMeal, setSelectedMeal] = useState('All');
  const [menuData, setMenuData] = useState<MenuData | null>(null);
  const [hoursData, setHoursData] = useState<DiningHallHours | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diningHalls = ['Buckley', 'McMahon', 'North', 'Northwest', 'Putnam', 'South', 'Towers', 'Whitney'];

  useEffect(() => {
    const fetchMenuAndHours = async () => {
      if (!selectedHall) return;

      setIsLoading(true);
      setError(null);
      setMenuData(null);
      setHoursData(null);

      try {
        const isDev = import.meta.env.DEV;
        const MENU_ENDPOINT = isDev
          ? '/api/menu'
          : (import.meta.env.VITE_MENU_ENDPOINT || 'http://localhost:8080/api/menu');
        const HOURS_ENDPOINT_BASE = isDev
          ? '/api/hours'
          : (import.meta.env.VITE_HOURS_ENDPOINT_BASE || 'http://localhost:8080/api/hours');
        // Fetch Menu
        let menuResponse;
        if (isDev) {
          const qs = new URLSearchParams({ diningHall: selectedHall, date: selectedDate.toISOString() });
          menuResponse = await fetch(`${MENU_ENDPOINT}?${qs.toString()}`, {
            method: 'GET',
          });
        } else {
          menuResponse = await fetch(MENU_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              diningHall: selectedHall,
              date: selectedDate.toISOString(),
            }),
          });
        }
        if (!menuResponse.ok) {
          const errorText = await menuResponse.text();
          try {
            const errorData = JSON.parse(errorText);
            throw new Error(errorData.error || 'Failed to fetch menu');
          } catch {
            throw new Error(errorText || 'Failed to fetch menu');
          }
        }
        const menu: MenuData = await menuResponse.json();
        setMenuData(menu);

        // Fetch Hours (always use query param form to avoid path parsing issues on CF)
        const hoursQs = new URLSearchParams({ diningHall: selectedHall });
        const hoursResponse = await fetch(`${HOURS_ENDPOINT_BASE}?${hoursQs.toString()}`);
        if (!hoursResponse.ok) throw new Error('Failed to fetch hours');
        const hours: DiningHallHours = await hoursResponse.json();
        setHoursData(hours);
      } catch (err: any) {
        setError(err.message);
        console.error('Error fetching data:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchMenuAndHours();
  }, [selectedHall, selectedDate]);

  const formatDate = (date: Date) => date.toISOString().split('T')[0];

  const formatMealTimes = (mealTimes: Hours[]) => {
    if (!mealTimes || mealTimes.length === 0) return 'Not served';
    const uniqueTimes = [...new Set(mealTimes.map(t => `${t.start} - ${t.end}`))];
    return uniqueTimes.join(', ');
  };

  const availableMeals = menuData?.meals.map(m => m.name) || [];

  return (
    <div className="w-full h-full p-2 flex flex-col text-foreground">
      <h2 className="text-3xl font-bold text-center mb-6">UConn Dining Hall Menus</h2>
      
      {/* Controls */}
      <div className="flex flex-col md:flex-row justify-center items-center gap-4 mb-6">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-[180px]">
              {selectedHall || "Select a Hall"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[180px]">
            {diningHalls.map(hall => (
              <DropdownMenuItem key={hall} onSelect={() => setSelectedHall(hall)}>
                {hall}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2">
          <input type="date" id="date-picker" value={formatDate(selectedDate)} onChange={(e) => setSelectedDate(new Date(e.target.value))} className="bg-card border border-border rounded-md p-2 text-foreground" />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-[180px]" disabled={!menuData}>
              {selectedMeal || "Select a Meal"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[180px]">
             <DropdownMenuItem onSelect={() => setSelectedMeal('All')}>All Meals</DropdownMenuItem>
            {availableMeals.map(meal => (
              <DropdownMenuItem key={meal} onSelect={() => setSelectedMeal(meal)}>
                {meal}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      <div className="flex-grow overflow-hidden grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Hours */}
        <div className="md:col-span-1">
          <Card className="bg-card border-border h-full">
            <CardHeader>
              <CardTitle className="text-center text-xl text-primary">{selectedHall} Hours</CardTitle>
            </CardHeader>
            <CardContent className="text-center">
              {isLoading && <p>Loading hours...</p>}
              {error && !hoursData && <p className="text-destructive">Hours unavailable</p>}
              {hoursData && (
                <div className="space-y-2">
                  <p><strong>Breakfast:</strong> {formatMealTimes(hoursData.BREAKFAST)}</p>
                  <p><strong>Lunch:</strong> {formatMealTimes(hoursData.LUNCH)}</p>
                  <p><strong>Dinner:</strong> {formatMealTimes(hoursData.DINNER)}</p>
                  {hoursData.LATE_NIGHT?.length > 0 && <p><strong>Late Night:</strong> {formatMealTimes(hoursData.LATE_NIGHT)}</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Menu */}
        <div className="md:col-span-2 overflow-hidden flex flex-col">
          {isLoading && <p className="text-center">Loading menu...</p>}
          {error && <p className="text-center text-destructive">Error: {error}</p>}
          {!menuData && !isLoading && !error && <p className="text-center">No menu data available for this day.</p>}
          
          {menuData && (
            <div className="flex-grow overflow-y-auto pr-4 menu-content">
              <h3 className="text-2xl font-semibold text-primary text-center mb-4">{menuData.name} - {menuData.status}</h3>
              {menuData.meals
                .filter(meal => selectedMeal === 'All' || meal.name === selectedMeal)
                .map(meal => (
                  <Card key={meal.name} className="bg-card border-border mb-4">
                    <CardHeader>
                      <CardTitle className="text-lg">{meal.name}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {meal.stations.map(station => (
                        <div key={station.name} className="mb-3">
                          <h5 className="font-semibold text-primary/80 mb-2">{station.name}</h5>
                          <ul className="list-disc list-inside">
                            {station.options.map((option, index) => <li key={index} className="ml-4">{option}</li>)}
                          </ul>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DiningHallMenu; 